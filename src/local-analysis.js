import { createHash } from 'node:crypto';
import { isLockFile, matchStripPattern } from './git.js';
import { ERROR_CATEGORIES, fail } from './errors.js';

// These are evidence-selection rules, not exclusions from Git or secret scans.
export function isGeneratedFile(path) {
  return (
    /(?:^|\/)(?:dist|build|coverage|vendor|node_modules)\//.test(path) ||
    /(?:\.min\.(?:js|css)|\.map|\.snap|\.generated\.[^/]+)$/.test(path)
  );
}

export function isDeepAnalysis(config) {
  return config.largeChange?.strategy === 'deep';
}

function clip(text, bytes) {
  if (Buffer.byteLength(text) <= bytes) return text;
  let result = '';
  let size = 0;
  for (const char of text) {
    size += Buffer.byteLength(char);
    if (size > Math.max(0, bytes - 3)) break;
    result += char;
  }
  return result + '…';
}

function category(file, config) {
  if (isLockFile(file.path)) return 'lockfile';
  if (matchStripPattern(file.path, config.stripFiles)) return 'excluded';
  if (isGeneratedFile(file.path)) return 'generated';
  if (/(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\./.test(file.path)) return 'test';
  if (/\.(?:md|rst|txt)$/.test(file.path)) return 'documentation';
  if (/(?:^|\/)(?:[^/]*config[^/]*|package\.json)$|\.(?:ya?ml|toml)$/.test(file.path))
    return 'configuration';
  return 'source';
}

function moduleOf(path) {
  const parts = path.split('/');
  return parts.length === 1 ? '.' : parts.slice(0, Math.min(parts.length - 1, 2)).join('/');
}

export function localInputBytes(config) {
  // UTF-8 bytes also bound non-ASCII input. Leave space for JSON escaping,
  // repository context, policy, and the provider's message envelope.
  return Math.max(
    256,
    Math.min(
      config.maxDiffChars || 30000,
      Math.floor((config.analysisBudget?.limits.chunkInputTokens || 12000) * 0.6),
    ),
  );
}

function summaryOf(fact, evidence = true) {
  return {
    id: fact.id,
    kind: fact.kind,
    status: fact.status,
    module: clip(fact.module, 160),
    fileCount: fact.files.length,
    additions: fact.additions,
    deletions: fact.deletions,
    ...(fact.modeChange ? { modeChange: fact.modeChange } : {}),
    ...(fact.binary ? { binary: true } : {}),
    examples: fact.files.slice(0, 2).map((path) => clip(path, 180)),
    ...(evidence && fact.evidence ? { representativeExcerpt: fact.evidence } : {}),
  };
}

const SAMPLE_NOTICE =
  'Local change inventory with selected excerpts, not complete semantic analysis. ' +
  'Counts cover every file. Excerpts are partial; omitted content and paths are not evidence of unchanged behavior. ' +
  'Identical textual edits are grouped within a module. Describe supported changes conservatively; do not infer intent.';

function ranked(facts) {
  const priority = { source: 0, configuration: 1, test: 2, documentation: 3 };
  return [...facts].sort(
    (a, b) =>
      (priority[a.kind] ?? 4) - (priority[b.kind] ?? 4) ||
      b.files.length - a.files.length ||
      a.id.localeCompare(b.id),
  );
}

export function localOverview(config, facts) {
  const kinds = {};
  const statuses = {};
  let totalFiles = 0;
  let additions = 0;
  let deletions = 0;
  let modeChangedFiles = 0;
  let binaryFiles = 0;
  for (const fact of facts) {
    totalFiles += fact.files.length;
    additions += fact.additions;
    deletions += fact.deletions;
    if (fact.modeChange) modeChangedFiles += fact.files.length;
    if (fact.binary) binaryFiles += fact.files.length;
    kinds[fact.kind] = (kinds[fact.kind] || 0) + fact.files.length;
    statuses[fact.status] = (statuses[fact.status] || 0) + fact.files.length;
  }
  const data = {
    notice: SAMPLE_NOTICE,
    totalFiles,
    additions,
    deletions,
    modeChangedFiles,
    binaryFiles,
    lineCounts: 'tracked diff only',
    kinds,
    statuses,
    totalGroups: facts.length,
    omittedGroups: facts.length,
    samples: [],
  };
  const cap = localInputBytes(config);
  let sampledFiles = 0;
  const seen = new Set();
  const ordered = ranked(facts);
  // First cover distinct modules/categories, then use remaining space for detail.
  const diverse = [];
  const rest = [];
  for (const fact of ordered) {
    const key = JSON.stringify([fact.module, fact.kind]);
    if (seen.has(key)) rest.push(fact);
    else {
      seen.add(key);
      diverse.push(fact);
    }
  }
  const firstKinds = new Set();
  const first = [];
  const remaining = [];
  for (const fact of diverse) {
    if (firstKinds.has(fact.kind)) remaining.push(fact);
    else {
      firstKinds.add(fact.kind);
      first.push(fact);
    }
  }
  for (const fact of [...first, ...remaining, ...rest]) {
    if (data.samples.length >= 16) break;
    const sample = summaryOf(fact);
    data.samples.push(sample);
    if (Buffer.byteLength(JSON.stringify(data)) > cap) {
      data.samples.pop();
      continue;
    }
    if (fact.evidence) sampledFiles++;
    data.omittedGroups--;
  }
  // A tiny configured budget may not even fit aggregate metadata. Fail before
  // sending rather than silently slicing JSON or dropping the uncertainty notice.
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text) > cap)
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      'Local change inventory does not fit the input budget. Increase largeChange.chunkInputTokens or maxDiffChars.',
    );
  return { text, sampledFiles };
}

export function analyzeLocally(config, capture, protect, previews) {
  const records = new Map(
    capture.manifest.map((file) => [
      file.id,
      {
        file,
        hash: createHash('sha256'),
        evidence: '',
        textual: false,
      },
    ]),
  );
  for (const unit of capture.units(protect, previews)) {
    if (unit.metadataOnly) continue;
    const record = records.get(unit.fileId);
    // Tracked fragments carry Git headers; untracked fragments are plain text.
    const section = unit.id.match(/S\d+(?=P\d+$)/)?.[0];
    if (section && section !== record.section) {
      record.section = section;
      record.inHunk = false;
    }
    for (const line of unit.text.split(/(?<=\n)/)) {
      if (section) {
        if (line.startsWith('@@')) record.inHunk = true;
        if (!record.inHunk || !/^[+-]/.test(line)) continue;
      }
      record.hash.update(line);
      record.textual = true;
      const remaining = 900 - Buffer.byteLength(record.evidence);
      if (remaining > 3) record.evidence += clip(line, remaining);
    }
  }
  const grouped = new Map();
  for (const { file, hash, evidence, textual } of records.values()) {
    const kind = category(file, config);
    const module = moduleOf(file.addPaths?.at(-1) || file.path);
    const status = file.status.replace(/\d+$/, '');
    const metadata = ['lockfile', 'excluded', 'generated'].includes(kind);
    const modeChange =
      file.oldMode && file.newMode && file.oldMode !== file.newMode
        ? `${file.oldMode} -> ${file.newMode}`
        : null;
    // Unknown/binary changes and renames stay independent for split safety.
    const identity = metadata
      ? 'metadata'
      : textual && !status.startsWith('R')
        ? hash.digest('hex')
        : file.id;
    const key = JSON.stringify([kind, module, status, identity, modeChange, !!file.binary]);
    let fact = grouped.get(key);
    if (!fact) {
      fact = {
        id: file.id,
        kind,
        module,
        status,
        files: [],
        additions: 0,
        deletions: 0,
        modeChange,
        binary: !!file.binary,
        evidence: metadata ? '' : evidence,
      };
      grouped.set(key, fact);
    }
    fact.files.push(file.path);
    fact.additions += file.additions;
    fact.deletions += file.deletions;
  }
  const facts = [...grouped.values()];
  const overview = localOverview(config, facts);
  return {
    facts,
    summary: overview.text,
    coverage: {
      strategy: 'auto',
      totalFiles: capture.manifest.length,
      analyzedFiles: 0,
      sampledFiles: overview.sampledFiles,
      metadataOnlyFiles: capture.manifest.length - overview.sampledFiles,
      failedFiles: 0,
      completedChunks: 0,
      cachedChunks: 0,
      requestedChunks: 0,
    },
  };
}

function planningBucketKey(fact) {
  const topLevel = fact.module === '.' ? '.' : fact.module.split('/')[0];
  return JSON.stringify([
    topLevel,
    fact.kind,
    fact.status,
    fact.modeChange || '',
    Boolean(fact.binary),
  ]);
}

function moduleSpan(facts) {
  const modules = [...new Set(facts.map((fact) => fact.module))];
  if (modules.length === 1) return modules[0];
  const parts = modules.map((module) => module.split('/'));
  const common = [];
  for (let index = 0; index < parts[0].length; index++) {
    const value = parts[0][index];
    if (!parts.every((item) => item[index] === value)) break;
    common.push(value);
  }
  return common.length ? `${common.join('/')}/*` : 'multiple modules';
}

// Extremely large auto-mode inventories cannot represent every independent
// file candidate to the model without hundreds of repeated requests. Bundle
// adjacent candidates locally while retaining their complete file mapping;
// the model groups bundle IDs, and execution still covers every original path.
export function compactLocalPlanFacts(config, facts) {
  const maxItems = config.splitMaxPlanFiles || 100;
  const threshold = maxItems * 4;
  if (facts.length <= threshold) {
    return { facts, originalCandidates: facts.length, planningCandidates: facts.length };
  }

  const target = Math.max(1, maxItems * 2);
  const bundleSize = Math.ceil(facts.length / target);
  const ordered = [...facts].sort(
    (left, right) =>
      planningBucketKey(left).localeCompare(planningBucketKey(right)) ||
      left.module.localeCompare(right.module) ||
      left.id.localeCompare(right.id),
  );
  const bundles = [];
  let bucket = [];
  let key = null;
  const flush = () => {
    if (!bucket.length) return;
    const first = bucket[0];
    const evidence = bucket.find((fact) => fact.evidence)?.evidence || '';
    const modeChanges = new Set(bucket.map((fact) => fact.modeChange).filter(Boolean));
    bundles.push({
      id: `C${bundles.length + 1}`,
      kind: first.kind,
      module: moduleSpan(bucket),
      status: first.status,
      files: bucket.flatMap((fact) => fact.files),
      additions: bucket.reduce((total, fact) => total + fact.additions, 0),
      deletions: bucket.reduce((total, fact) => total + fact.deletions, 0),
      modeChange: modeChanges.size === 1 ? [...modeChanges][0] : null,
      binary: bucket.some((fact) => fact.binary),
      evidence,
    });
    bucket = [];
  };

  for (const fact of ordered) {
    const nextKey = planningBucketKey(fact);
    if (bucket.length && (nextKey !== key || bucket.length >= bundleSize)) flush();
    key = nextKey;
    bucket.push(fact);
  }
  flush();
  return {
    facts: bundles,
    originalCandidates: facts.length,
    planningCandidates: bundles.length,
  };
}

export function localPlanBatches(config, facts, cap) {
  const error = () =>
    fail(ERROR_CATEGORIES.CONFIG, 'A split candidate is too large for one planning request.', {
      data: { fallbackPlan: true },
    });
  const maxItems = config.splitMaxPlanFiles || 100;
  const batches = [];
  let batch = [];
  for (const fact of facts) {
    const item = summaryOf(fact, false);
    if (Buffer.byteLength(JSON.stringify([item])) > cap) throw error();
    const candidate = [...batch, item];
    if (
      batch.length &&
      (candidate.length > maxItems || Buffer.byteLength(JSON.stringify(candidate)) > cap)
    ) {
      batches.push(batch);
      batch = [];
    }
    batch.push(item);
  }
  if (batch.length) batches.push(batch);

  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  let evidenceCount = 0;
  for (const items of batches) {
    for (const item of items) {
      if (evidenceCount >= 16) break;
      const evidence = factsById.get(item.id)?.evidence;
      if (!evidence) continue;
      item.representativeExcerpt = evidence;
      if (Buffer.byteLength(JSON.stringify(items)) > cap) delete item.representativeExcerpt;
      else evidenceCount++;
    }
  }
  return batches;
}

export function localPlanItems(config, facts, cap) {
  const batches = localPlanBatches(config, facts, cap);
  if (batches.length !== 1)
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      'The complete split candidate inventory requires multiple planning requests.',
      { data: { fallbackPlan: true } },
    );
  return batches[0];
}
