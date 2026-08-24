import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { normalizeCommitPolicy, validateCommitCandidate } from './policy.js';

export const SPLIT_PLAN_KIND = 'aicommit-split-plan';
export const SPLIT_PLAN_VERSION = 1;
const MAX_PLAN_BYTES = 1024 * 1024;
const HASH_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function safePath(value, label) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1000 ||
    value.includes('\0') ||
    isAbsolute(value) ||
    value === '..' ||
    value.startsWith('../') ||
    value.split(/[\\/]/).includes('..')
  ) {
    throw new Error(`${label} must be a safe repository-relative path.`);
  }
  return value;
}

function clonePolicy(policy, language) {
  const normalized = normalizeCommitPolicy(policy, language);
  return {
    version: normalized.version,
    types: [...normalized.types],
    scope: { ...normalized.scope, values: [...normalized.scope.values] },
    subject: { ...normalized.subject },
    body: { ...normalized.body },
    breakingChange: normalized.breakingChange,
    language: normalized.language,
  };
}

function normalizeChange(change, index) {
  if (!object(change)) throw new Error(`changes[${index}] must be an object.`);
  const keys = Object.keys(change);
  if (keys.some((key) => !['status', 'path', 'addPaths'].includes(key))) {
    throw new Error(`changes[${index}] contains an unknown property.`);
  }
  if (typeof change.status !== 'string' || !change.status || change.status.length > 8) {
    throw new Error(`changes[${index}].status must be a short non-empty string.`);
  }
  const path = safePath(change.path, `changes[${index}].path`);
  if (!Array.isArray(change.addPaths) || !change.addPaths.length || change.addPaths.length > 2) {
    throw new Error(`changes[${index}].addPaths must contain one or two paths.`);
  }
  const addPaths = change.addPaths.map((item, pathIndex) =>
    safePath(item, `changes[${index}].addPaths[${pathIndex}]`),
  );
  if (new Set(addPaths).size !== addPaths.length) {
    throw new Error(`changes[${index}].addPaths contains a duplicate path.`);
  }
  return { status: change.status, path, addPaths };
}

function normalizeGroup(group, index, allowedPaths, policy, language) {
  if (!object(group)) throw new Error(`groups[${index}] must be an object.`);
  const keys = Object.keys(group);
  if (keys.some((key) => !['message', 'files'].includes(key))) {
    throw new Error(`groups[${index}] contains an unknown property.`);
  }
  if (typeof group.message !== 'string' || !group.message.trim() || group.message.length > 10_000) {
    throw new Error(`groups[${index}].message must be a non-empty bounded string.`);
  }
  const validation = validateCommitCandidate(group.message, {
    policy: normalizeCommitPolicy(policy, language),
  });
  if (!validation.valid) {
    throw new Error(
      `groups[${index}].message violates commitPolicy: ${validation.errors
        .map((issue) => issue.message)
        .join(' ')}`,
    );
  }
  if (!Array.isArray(group.files) || !group.files.length) {
    throw new Error(`groups[${index}].files must not be empty.`);
  }
  const files = group.files.map((item, fileIndex) =>
    safePath(item, `groups[${index}].files[${fileIndex}]`),
  );
  if (new Set(files).size !== files.length) {
    throw new Error(`groups[${index}].files contains a duplicate path.`);
  }
  for (const path of files) {
    if (!allowedPaths.has(path))
      throw new Error(`groups[${index}] references unknown path: ${path}`);
  }
  return { message: validation.parsed.cleaned, files };
}

export function validateSplitPlanArtifact(input) {
  if (!object(input)) throw new Error('Split plan must be a JSON object.');
  const allowedKeys = new Set([
    'kind',
    'version',
    'createdAt',
    'scope',
    'baseHead',
    'fingerprint',
    'language',
    'commitPolicy',
    'changes',
    'groups',
  ]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new Error('Split plan contains an unknown top-level property.');
  }
  if (input.kind !== SPLIT_PLAN_KIND || input.version !== SPLIT_PLAN_VERSION) {
    throw new Error(`Unsupported split plan; expected ${SPLIT_PLAN_KIND} version 1.`);
  }
  if (typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error('Split plan createdAt must be an ISO timestamp.');
  }
  if (!['staged', 'all'].includes(input.scope)) {
    throw new Error('Split plan scope must be staged or all.');
  }
  if (
    input.baseHead !== null &&
    (typeof input.baseHead !== 'string' || !HASH_RE.test(input.baseHead))
  ) {
    throw new Error('Split plan baseHead must be a Git object id or null.');
  }
  if (typeof input.fingerprint !== 'string' || !FINGERPRINT_RE.test(input.fingerprint)) {
    throw new Error('Split plan fingerprint must be a SHA-256 digest.');
  }
  if (!['zh', 'en'].includes(input.language)) {
    throw new Error('Split plan language must be zh or en.');
  }
  const commitPolicy = clonePolicy(input.commitPolicy, input.language);
  if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > 10_000) {
    throw new Error('Split plan changes must contain 1-10000 entries.');
  }
  const changes = input.changes.map(normalizeChange);
  const displayPaths = changes.map((change) => change.path);
  if (new Set(displayPaths).size !== displayPaths.length) {
    throw new Error('Split plan changes contains duplicate display paths.');
  }
  if (!Array.isArray(input.groups) || !input.groups.length || input.groups.length > 1000) {
    throw new Error('Split plan groups must contain 1-1000 entries.');
  }
  const allowedPaths = new Set(displayPaths);
  const groups = input.groups.map((group, index) =>
    normalizeGroup(group, index, allowedPaths, commitPolicy, input.language),
  );
  const assigned = groups.flatMap((group) => group.files);
  if (new Set(assigned).size !== assigned.length) {
    throw new Error('Split plan assigns a path to more than one group.');
  }
  const missing = displayPaths.filter((path) => !assigned.includes(path));
  if (missing.length) throw new Error(`Split plan leaves paths unassigned: ${missing.join(', ')}`);

  return {
    kind: SPLIT_PLAN_KIND,
    version: SPLIT_PLAN_VERSION,
    createdAt: input.createdAt,
    scope: input.scope,
    baseHead: input.baseHead,
    fingerprint: input.fingerprint,
    language: input.language,
    commitPolicy,
    changes,
    groups,
  };
}

export function createSplitPlanArtifact({
  scope,
  baseHead,
  fingerprint,
  language,
  commitPolicy,
  changes,
  groups,
  createdAt = new Date().toISOString(),
}) {
  return validateSplitPlanArtifact({
    kind: SPLIT_PLAN_KIND,
    version: SPLIT_PLAN_VERSION,
    createdAt,
    scope,
    baseHead,
    fingerprint,
    language,
    commitPolicy,
    changes,
    groups,
  });
}

export async function writeSplitPlanArtifact(path, artifact) {
  const absolute = resolve(path);
  const validated = validateSplitPlanArtifact(artifact);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(validated, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, absolute);
  } catch (err) {
    await unlink(temporary).catch(() => {});
    throw err;
  }
  return absolute;
}

export async function readSplitPlanArtifact(path) {
  const absolute = resolve(path);
  const stat = await lstat(absolute).catch((err) => {
    if (err.code === 'ENOENT') throw new Error(`Split plan not found: ${absolute}`);
    throw err;
  });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Split plan must be a regular, non-symbolic-link file.');
  }
  if (stat.size > MAX_PLAN_BYTES) throw new Error('Split plan exceeds the 1 MiB limit.');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(absolute, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse split plan ${absolute}: ${err.message}`);
  }
  return { path: absolute, artifact: validateSplitPlanArtifact(parsed) };
}
