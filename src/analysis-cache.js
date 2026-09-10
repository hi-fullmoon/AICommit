import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const ANALYSIS_CACHE_KIND = 'aicommit-analysis-cache-entry';
export const ANALYSIS_CACHE_VERSION = 1;
// Bump whenever the fragment-analysis prompt or summary contract changes.
export const ANALYSIS_CONTRACT_VERSION = 1;
const MAX_ENTRY_BYTES = 128 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonical(value[key])]),
  );
}

function digest(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function cacheRoot(projectRoot) {
  const raw = execFileSync(
    'git',
    ['rev-parse', '--git-path', `aicommit/analysis-cache/v${ANALYSIS_CACHE_VERSION}`],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ).trim();
  return isAbsolute(raw) ? raw : resolve(projectRoot, raw);
}

function namespaceSignature(config, protect) {
  return digest({
    contractVersion: ANALYSIS_CONTRACT_VERSION,
    providerType: config.providerType || '',
    apiUrl: config.apiUrl,
    modelId: config.modelId,
    reasoning: config.reasoning,
    extraBody: config.extraBody,
    protect,
  });
}

function normalizeGroups(groups) {
  if (!Array.isArray(groups) || !groups.length || groups.length > 16) {
    throw new Error('Analysis cache groups must be a non-empty bounded array.');
  }
  return groups.map((group) => {
    if (
      !object(group) ||
      !Array.isArray(group.ids) ||
      !group.ids.length ||
      group.ids.some((id) => typeof id !== 'string' || !id || id.length > 128) ||
      typeof group.summary !== 'string' ||
      !group.summary.trim() ||
      group.summary.length > 2000
    ) {
      throw new Error('Analysis cache contains an invalid group.');
    }
    return { ids: [...group.ids], summary: group.summary };
  });
}

function validateEntry(input, expectedIds) {
  if (
    !object(input) ||
    Object.keys(input).some(
      (key) => !['kind', 'version', 'createdAt', 'ids', 'groups'].includes(key),
    ) ||
    input.kind !== ANALYSIS_CACHE_KIND ||
    input.version !== ANALYSIS_CACHE_VERSION ||
    typeof input.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(input.createdAt)) ||
    !Array.isArray(input.ids) ||
    input.ids.length !== expectedIds.length ||
    input.ids.some((id, index) => id !== expectedIds[index])
  ) {
    throw new Error('Analysis cache entry is invalid or belongs to another chunk.');
  }
  return normalizeGroups(input.groups);
}

function namespaceRecords(root) {
  if (!existsSync(root)) return [];
  const records = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    let bytes = 0;
    let modified = lstatSync(path).mtimeMs;
    for (const child of readdirSync(path, { withFileTypes: true })) {
      if (!child.isFile() || child.isSymbolicLink()) continue;
      const stat = statSync(join(path, child.name));
      bytes += stat.size;
      modified = Math.max(modified, stat.mtimeMs);
    }
    records.push({ path, bytes, modified });
  }
  return records;
}

function prune(root, settings, keep = null, now = Date.now()) {
  try {
    let records = namespaceRecords(root);
    for (const record of records) {
      if (record.path !== keep && now - record.modified > settings.ttlMs) {
        rmSync(record.path, { recursive: true, force: true });
      }
    }
    records = namespaceRecords(root).sort((left, right) => left.modified - right.modified);
    let total = records.reduce((sum, record) => sum + record.bytes, 0);
    for (const record of records) {
      if (total <= settings.maxBytes) break;
      if (record.path === keep) continue;
      rmSync(record.path, { recursive: true, force: true });
      total -= record.bytes;
    }
  } catch {
    // A cache maintenance failure must never block commit generation.
  }
}

export function createAnalysisCache({ projectRoot, snapshotFingerprint, config, protect = true }) {
  const settings = config.largeChange?.cache;
  if (
    !settings?.enabled ||
    config.largeChange?.strategy !== 'deep' ||
    !SHA256_RE.test(snapshotFingerprint || '') ||
    (!protect && !settings.allowUnprotected)
  ) {
    return null;
  }

  try {
    const root = cacheRoot(projectRoot);
    const signature = namespaceSignature(config, protect);
    const namespace = join(root, `${snapshotFingerprint}.${signature}`);
    prune(root, settings);
    mkdirSync(namespace, { recursive: true, mode: 0o700 });

    return {
      keyFor(task, input) {
        return digest({
          contractVersion: ANALYSIS_CONTRACT_VERSION,
          signature,
          task,
          input,
        });
      },
      read(key, expectedIds, validate) {
        if (!SHA256_RE.test(key)) return null;
        const path = join(namespace, `${key}.json`);
        try {
          const stat = lstatSync(path);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ENTRY_BYTES) return null;
          const groups = validateEntry(JSON.parse(readFileSync(path, 'utf8')), expectedIds);
          validate?.(groups);
          const now = new Date();
          utimesSync(namespace, now, now);
          return groups;
        } catch {
          return null;
        }
      },
      write(key, ids, groups) {
        if (!SHA256_RE.test(key)) return false;
        let entry;
        try {
          entry = {
            kind: ANALYSIS_CACHE_KIND,
            version: ANALYSIS_CACHE_VERSION,
            createdAt: new Date().toISOString(),
            ids: [...ids],
            groups: normalizeGroups(groups),
          };
        } catch {
          return false;
        }
        const path = join(namespace, `${key}.json`);
        const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
        try {
          const contents = JSON.stringify(entry) + '\n';
          const bytes = Buffer.byteLength(contents);
          const current = namespaceRecords(root).find((record) => record.path === namespace);
          let existingBytes = 0;
          try {
            existingBytes = lstatSync(path).size;
          } catch (error) {
            if (error.code !== 'ENOENT') return false;
          }
          if (
            bytes > MAX_ENTRY_BYTES ||
            (current?.bytes || 0) - existingBytes + bytes > settings.maxBytes
          ) {
            return false;
          }
          writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600 });
          renameSync(temporary, path);
          prune(root, settings, namespace);
          return true;
        } catch {
          rmSync(temporary, { force: true });
          return false;
        }
      },
      clear() {
        try {
          rmSync(namespace, { recursive: true, force: true });
          const parent = dirname(namespace);
          if (existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent);
        } catch {
          // Cache cleanup is best-effort and does not affect the completed result.
        }
      },
      path: namespace,
    };
  } catch {
    return null;
  }
}
