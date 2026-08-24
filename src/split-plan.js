import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { normalizeCommitPolicy, validateCommitCandidate } from './policy.js';

export const SPLIT_PLAN_KIND = 'aicommit-split-plan';
export const SPLIT_PLAN_VERSION = 1;
const MAX_PLAN_BYTES = 1024 * 1024;
const HASH_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const HUNK_HASH_RE = /^[0-9a-f]{64}$/;

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
  if (keys.some((key) => !['status', 'path', 'addPaths', 'hunks'].includes(key))) {
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
  let hunks;
  if (change.hunks !== undefined) {
    if (!Array.isArray(change.hunks) || change.hunks.length < 2 || change.hunks.length > 1000) {
      throw new Error(`changes[${index}].hunks must contain 2-1000 entries.`);
    }
    hunks = change.hunks.map((hunk, hunkIndex) => {
      if (
        !object(hunk) ||
        Object.keys(hunk).some(
          (key) => !['id', 'hash', 'oldStart', 'oldLines', 'newStart', 'newLines'].includes(key),
        ) ||
        typeof hunk.id !== 'string' ||
        !/^H[1-9]\d*$/.test(hunk.id) ||
        typeof hunk.hash !== 'string' ||
        !HUNK_HASH_RE.test(hunk.hash)
      ) {
        throw new Error(`changes[${index}].hunks[${hunkIndex}] is invalid.`);
      }
      for (const key of ['oldStart', 'oldLines', 'newStart', 'newLines']) {
        if (!Number.isInteger(hunk[key]) || hunk[key] < 0) {
          throw new Error(`changes[${index}].hunks[${hunkIndex}].${key} is invalid.`);
        }
      }
      return {
        id: hunk.id,
        hash: hunk.hash,
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
      };
    });
    if (new Set(hunks.map((hunk) => hunk.id)).size !== hunks.length) {
      throw new Error(`changes[${index}].hunks contains a duplicate id.`);
    }
  }
  return { status: change.status, path, addPaths, ...(hunks ? { hunks } : {}) };
}

function normalizeGroup(group, index, allowedPaths, hunkCatalog, policy, language) {
  if (!object(group)) throw new Error(`groups[${index}] must be an object.`);
  const keys = Object.keys(group);
  if (keys.some((key) => !['message', 'files', 'hunks'].includes(key))) {
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
  if (!Array.isArray(group.files)) {
    throw new Error(`groups[${index}].files must be an array.`);
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
  let hunks = [];
  if (group.hunks !== undefined) {
    if (!Array.isArray(group.hunks)) throw new Error(`groups[${index}].hunks must be an array.`);
    hunks = group.hunks.map((assignment, assignmentIndex) => {
      if (
        !object(assignment) ||
        Object.keys(assignment).some((key) => !['path', 'ids'].includes(key)) ||
        typeof assignment.path !== 'string' ||
        !hunkCatalog.has(assignment.path) ||
        !Array.isArray(assignment.ids) ||
        !assignment.ids.length
      ) {
        throw new Error(`groups[${index}].hunks[${assignmentIndex}] is invalid.`);
      }
      const path = safePath(assignment.path, `groups[${index}].hunks[${assignmentIndex}].path`);
      const ids = assignment.ids.map((id) => {
        if (typeof id !== 'string' || !hunkCatalog.get(path).has(id)) {
          throw new Error(`groups[${index}] references unknown hunk: ${path}#${id}`);
        }
        return id;
      });
      if (new Set(ids).size !== ids.length) {
        throw new Error(`groups[${index}].hunks[${assignmentIndex}] contains a duplicate id.`);
      }
      return { path, ids };
    });
    if (new Set(hunks.map((assignment) => assignment.path)).size !== hunks.length) {
      throw new Error(`groups[${index}].hunks contains a duplicate path.`);
    }
  }
  if (!files.length && !hunks.length) throw new Error(`groups[${index}] must not be empty.`);
  return { message: validation.parsed.cleaned, files, ...(hunks.length ? { hunks } : {}) };
}

export function validateSplitPlanArtifact(input) {
  if (!object(input)) throw new Error('Split plan must be a JSON object.');
  const allowedKeys = new Set([
    'kind',
    'version',
    'createdAt',
    'hunkMode',
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
  const hunkMode = input.hunkMode === true;
  if (input.hunkMode !== undefined && typeof input.hunkMode !== 'boolean') {
    throw new Error('Split plan hunkMode must be a boolean.');
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
  const hunkCatalog = new Map(
    changes
      .filter((change) => change.hunks?.length)
      .map((change) => [change.path, new Set(change.hunks.map((hunk) => hunk.id))]),
  );
  if (!hunkMode && hunkCatalog.size) {
    throw new Error('Split plan cannot contain a hunk catalog when hunkMode is disabled.');
  }
  const groups = input.groups.map((group, index) =>
    normalizeGroup(group, index, allowedPaths, hunkCatalog, commitPolicy, input.language),
  );
  const assignedFiles = groups.flatMap((group) => group.files);
  if (new Set(assignedFiles).size !== assignedFiles.length) {
    throw new Error('Split plan assigns a path to more than one group.');
  }
  const assignedHunks = new Set();
  for (const group of groups) {
    for (const assignment of group.hunks || []) {
      if (assignedFiles.includes(assignment.path)) {
        throw new Error(`Split plan assigns both a whole file and hunks: ${assignment.path}`);
      }
      for (const id of assignment.ids) {
        const key = `${assignment.path}\0${id}`;
        if (assignedHunks.has(key)) {
          throw new Error(`Split plan assigns a hunk more than once: ${assignment.path}#${id}`);
        }
        assignedHunks.add(key);
      }
    }
  }
  const missing = displayPaths.filter((path) => {
    if (assignedFiles.includes(path)) return false;
    const ids = hunkCatalog.get(path);
    return !ids || [...ids].some((id) => !assignedHunks.has(`${path}\0${id}`));
  });
  if (missing.length) throw new Error(`Split plan leaves paths unassigned: ${missing.join(', ')}`);

  return {
    kind: SPLIT_PLAN_KIND,
    version: SPLIT_PLAN_VERSION,
    createdAt: input.createdAt,
    hunkMode,
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
  hunkMode = false,
  createdAt = new Date().toISOString(),
}) {
  return validateSplitPlanArtifact({
    kind: SPLIT_PLAN_KIND,
    version: SPLIT_PLAN_VERSION,
    createdAt,
    hunkMode,
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
