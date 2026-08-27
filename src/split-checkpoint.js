import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';

import { validateSplitPlanArtifact } from './split-plan.js';

export const SPLIT_CHECKPOINT_KIND = 'aicommit-split-checkpoint';
export const SPLIT_CHECKPOINT_VERSION = 1;
const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function checkpointFile(projectRoot) {
  const raw = execFileSync('git', ['rev-parse', '--git-path', 'aicommit/split-checkpoint.json'], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  return isAbsolute(raw) ? raw : resolve(projectRoot, raw);
}

function validateEntry(entry, label) {
  if (entry === null) return null;
  if (
    !object(entry) ||
    Object.keys(entry).some((key) => !['mode', 'oid'].includes(key)) ||
    typeof entry.mode !== 'string' ||
    !/^\d{6}$/.test(entry.mode) ||
    typeof entry.oid !== 'string' ||
    !OID_RE.test(entry.oid)
  ) {
    throw new Error(`${label} must be null or a Git mode/object pair.`);
  }
  return { mode: entry.mode, oid: entry.oid };
}

function validateCommitRecord(record, index) {
  if (
    !object(record) ||
    Object.keys(record).some((key) => !['index', 'commit', 'parent', 'tree'].includes(key)) ||
    record.index !== index ||
    typeof record.commit !== 'string' ||
    !OID_RE.test(record.commit) ||
    (record.parent !== null &&
      (typeof record.parent !== 'string' || !OID_RE.test(record.parent))) ||
    typeof record.tree !== 'string' ||
    !OID_RE.test(record.tree)
  ) {
    throw new Error(`completed[${index}] is invalid or non-contiguous.`);
  }
  return { index, commit: record.commit, parent: record.parent, tree: record.tree };
}

function validateInFlight(record, completedCount, groupCount) {
  if (record === null) return null;
  if (
    !object(record) ||
    Object.keys(record).some((key) => !['index', 'parent', 'tree'].includes(key)) ||
    record.index !== completedCount ||
    record.index >= groupCount ||
    (record.parent !== null &&
      (typeof record.parent !== 'string' || !OID_RE.test(record.parent))) ||
    typeof record.tree !== 'string' ||
    !OID_RE.test(record.tree)
  ) {
    throw new Error('Checkpoint inFlight record is invalid.');
  }
  return { index: record.index, parent: record.parent, tree: record.tree };
}

export function validateSplitCheckpoint(input) {
  if (!object(input)) throw new Error('Split checkpoint must be a JSON object.');
  const allowed = new Set([
    'kind',
    'version',
    'transactionId',
    'createdAt',
    'updatedAt',
    'plan',
    'snapshots',
    'completed',
    'inFlight',
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error('Split checkpoint contains an unknown property.');
  }
  if (input.kind !== SPLIT_CHECKPOINT_KIND || input.version !== SPLIT_CHECKPOINT_VERSION) {
    throw new Error('Unsupported split checkpoint version.');
  }
  if (typeof input.transactionId !== 'string' || !/^[0-9a-f]{64}$/.test(input.transactionId)) {
    throw new Error('Split checkpoint transactionId must be a SHA-256 digest.');
  }
  for (const key of ['createdAt', 'updatedAt']) {
    if (typeof input[key] !== 'string' || !Number.isFinite(Date.parse(input[key]))) {
      throw new Error(`Split checkpoint ${key} must be an ISO timestamp.`);
    }
  }
  const plan = validateSplitPlanArtifact(input.plan);
  const realPaths = new Set(plan.changes.flatMap((change) => change.addPaths));
  if (!Array.isArray(input.snapshots) || input.snapshots.length !== realPaths.size) {
    throw new Error('Split checkpoint snapshots must cover every real path exactly once.');
  }
  const seen = new Set();
  const snapshots = input.snapshots.map((snapshot, index) => {
    if (
      !object(snapshot) ||
      Object.keys(snapshot).some((key) => !['path', 'target', 'index'].includes(key)) ||
      typeof snapshot.path !== 'string' ||
      !realPaths.has(snapshot.path) ||
      seen.has(snapshot.path)
    ) {
      throw new Error(`snapshots[${index}] has an unknown or duplicate path.`);
    }
    seen.add(snapshot.path);
    return {
      path: snapshot.path,
      target: validateEntry(snapshot.target, `snapshots[${index}].target`),
      index: validateEntry(snapshot.index, `snapshots[${index}].index`),
    };
  });
  if (!Array.isArray(input.completed) || input.completed.length > plan.groups.length) {
    throw new Error('Split checkpoint completed list is invalid.');
  }
  const completed = input.completed.map(validateCommitRecord);
  const inFlight = validateInFlight(input.inFlight, completed.length, plan.groups.length);
  return {
    kind: SPLIT_CHECKPOINT_KIND,
    version: SPLIT_CHECKPOINT_VERSION,
    transactionId: input.transactionId,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    plan,
    snapshots: snapshots.sort((left, right) => left.path.localeCompare(right.path)),
    completed,
    inFlight,
  };
}

export function splitCheckpointPath(projectRoot) {
  return checkpointFile(projectRoot);
}

export function assertNoSplitCheckpoint(projectRoot) {
  const path = checkpointFile(projectRoot);
  if (existsSync(path)) {
    throw new Error(
      `An unfinished split checkpoint already exists: ${path}\n` +
        'Resume it with "aicommit split resume", or discard only the checkpoint with ' +
        '"aicommit split abort". Discarding keeps existing commits and current changes.',
    );
  }
  return path;
}

export function createSplitCheckpoint(projectRoot, plan, snapshots) {
  const path = assertNoSplitCheckpoint(projectRoot);
  const now = new Date().toISOString();
  const transactionId = createHash('sha256')
    .update(JSON.stringify({ plan, snapshots, createdAt: now }))
    .digest('hex');
  const checkpoint = validateSplitCheckpoint({
    kind: SPLIT_CHECKPOINT_KIND,
    version: SPLIT_CHECKPOINT_VERSION,
    transactionId,
    createdAt: now,
    updatedAt: now,
    plan,
    snapshots,
    completed: [],
    inFlight: null,
  });
  writeSplitCheckpoint(projectRoot, checkpoint);
  return { path, checkpoint };
}

export function readSplitCheckpoint(projectRoot) {
  const path = checkpointFile(projectRoot);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`No split checkpoint found: ${path}`);
    throw err;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Split checkpoint must be a regular, non-symbolic-link file.');
  }
  if (stat.size > MAX_CHECKPOINT_BYTES) throw new Error('Split checkpoint exceeds 2 MiB.');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse split checkpoint ${path}: ${err.message}`);
  }
  return { path, checkpoint: validateSplitCheckpoint(parsed) };
}

export function writeSplitCheckpoint(projectRoot, input) {
  const path = checkpointFile(projectRoot);
  const checkpoint = validateSplitCheckpoint({
    ...input,
    updatedAt: new Date().toISOString(),
  });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(checkpoint, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
  return { path, checkpoint };
}

export function removeSplitCheckpoint(projectRoot) {
  rmSync(checkpointFile(projectRoot), { force: true });
}

// Explicitly abandoning recovery removes only AICommit's metadata. It never
// rewrites HEAD, the index, or the worktree. A symlink at the fixed checkpoint
// path is safe to unlink, but directories and special files are left alone.
export function discardSplitCheckpoint(projectRoot) {
  const path = checkpointFile(projectRoot);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`No split checkpoint found: ${path}`);
    throw err;
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error('Split checkpoint must be a regular file or symbolic link to discard it.');
  }
  rmSync(path);
  return path;
}
