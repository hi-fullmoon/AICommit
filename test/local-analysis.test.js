import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  analysisConfig,
  analyzeChanges,
  captureChanges,
  summarizeChanges,
} from '../src/change-analysis.js';
import { getStagedChangedFiles } from '../src/split.js';
import { cleanupGitSpools } from '../src/git-spool.js';
import { compactLocalPlanFacts, localInputBytes, localPlanBatches } from '../src/local-analysis.js';

function config() {
  return analysisConfig({
    ...DEFAULT_CONFIG,
    apiUrl: 'http://localhost:12345/v1/chat/completions',
    modelId: 'test-model',
    apiKey: '',
    reasoning: { ...DEFAULT_CONFIG.reasoning, mode: 'off' },
  });
}

function noNetwork(t) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('Unexpected provider request');
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return () => calls;
}

test('local inventory deduplicates full edits, preserves module boundaries and protects omitted content', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'aicommit-local-test-'));
  t.after(() => {
    cleanupGitSpools();
    rmSync(cwd, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  const files = {
    'src/a.js': 'const same = true;\n',
    'src/b.js': 'const same = true;\n',
    'other/c.js': 'const same = true;\n',
    'src/long-a.js': 'const prefix = true;\n'.repeat(200) + 'const tail = 1;\n',
    'src/long-b.js': 'const prefix = true;\n'.repeat(200) + 'const tail = 2;\n',
    'src/plus.js': '++validContent;\n',
    'tests/a.test.js': 'assert.equal(same, true);\n',
    'config.json': '{"enabled":true}\n',
    'dist/app.js': 'generatedBodyMustNotLeave\n'.repeat(200),
    'key.txt': 'privateBodyMustNotLeave\n'.repeat(200) + '-----BEGIN PRIVATE KEY-----\nPRIVATE\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  git('add', '-A');
  const cfg = config();
  const capture = captureChanges([['diff', '--staged']], cwd, getStagedChangedFiles(cwd), cfg);
  const calls = noNetwork(t);
  const result = await analyzeChanges(cfg, capture);
  const repeated = result.facts.find((fact) => fact.files.includes('src/a.js'));
  assert.deepEqual(repeated.files, ['src/a.js', 'src/b.js']);
  assert.equal(result.facts.find((fact) => fact.files.includes('other/c.js')).files.length, 1);
  for (const path of ['src/long-a.js', 'src/long-b.js'])
    assert.equal(result.facts.find((fact) => fact.files.includes(path)).files.length, 1);
  assert.match(
    result.facts.find((fact) => fact.files.includes('src/plus.js')).evidence,
    /\+\+validContent/,
  );
  const summary = await summarizeChanges(cfg, result.facts);
  assert.doesNotMatch(
    summary + JSON.stringify(result.facts),
    /generatedBodyMustNotLeave|privateBodyMustNotLeave|PRIVATE/,
  );
  assert.match(summary, /not complete semantic analysis/);
  assert.ok(capture.findings.some((finding) => finding.includes('private-key')));
  assert.equal(capture.stats.additions, 810);
  assert.equal(result.coverage.totalFiles, 10);
  assert.equal(result.coverage.analyzedFiles, 0);
  assert.equal(result.coverage.sampledFiles + result.coverage.metadataOnlyFiles, 10);
  const data = JSON.parse(summary);
  assert.ok(data.samples.some((sample) => sample.kind === 'test'));
  assert.ok(data.samples.some((sample) => sample.kind === 'configuration'));
  assert.equal(calls(), 0);
});

test(
  'local metadata preserves mode changes, renames and binary files without model analysis',
  { skip: process.platform === 'win32' },
  async (t) => {
    const cwd = mkdtempSync(join(tmpdir(), 'aicommit-local-metadata-'));
    t.after(() => {
      cleanupGitSpools();
      rmSync(cwd, { recursive: true, force: true });
    });
    const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'core.fileMode', 'true');
    writeFileSync(join(cwd, 'run.sh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(cwd, 'run.sh'), 0o644);
    writeFileSync(join(cwd, 'old.js'), 'const retained = true;\n');
    writeFileSync(join(cwd, 'blob.bin'), Buffer.from([0, 1, 2]));
    git('add', '-A');
    git('commit', '-qm', 'initial');
    chmodSync(join(cwd, 'run.sh'), 0o755);
    renameSync(join(cwd, 'old.js'), join(cwd, 'new.js'));
    writeFileSync(join(cwd, 'blob.bin'), Buffer.from([0, 2, 3]));
    git('add', '-A');
    const cfg = config();
    const capture = captureChanges([['diff', '--staged']], cwd, getStagedChangedFiles(cwd), cfg);
    const calls = noNetwork(t);
    const result = await analyzeChanges(cfg, capture);
    const data = JSON.parse(result.summary);
    assert.equal(data.modeChangedFiles, 1);
    assert.equal(data.binaryFiles, 1);
    assert.equal(data.statuses.R, 1);
    assert.match(result.summary, /100644 -> 100755/);
    assert.equal(result.coverage.metadataOnlyFiles, 3);
    assert.equal(calls(), 0);
  },
);

test('ten thousand independent edits produce bounded local planning batches without spending tokens', async (t) => {
  const cfg = config();
  const manifest = Array.from({ length: 10000 }, (_, i) => ({
    id: `F${i}`,
    path: i === 9999 ? 'tests/中文.test.js' : `src/module-${i}/中文.js`,
    status: 'M',
    additions: 1,
    deletions: 1,
  }));
  const capture = {
    manifest,
    *units() {
      for (const file of manifest)
        yield {
          id: `${file.id}S0P1`,
          fileId: file.id,
          metadataOnly: false,
          text: `diff --git a/${file.path} b/${file.path}\n@@ -1 +1 @@\n-const 中文 = 0;\n+const 中文 = ${file.id};\n`,
        };
    },
  };
  const calls = noNetwork(t);
  const result = await analyzeChanges(cfg, capture);
  const summary = await summarizeChanges(cfg, result.facts);
  const data = JSON.parse(summary);
  assert.equal(data.totalFiles, 10000);
  assert.equal(data.totalGroups, 10000);
  assert.equal(data.additions, 10000);
  assert.equal(data.deletions, 10000);
  assert.ok(data.omittedGroups > 0);
  assert.ok(data.samples.some((sample) => sample.kind === 'test'));
  assert.ok(Buffer.byteLength(summary) <= localInputBytes(cfg));
  assert.doesNotMatch(summary, /\uFFFD/);
  const cap = Math.min(
    cfg.splitMaxDiffChars,
    Math.floor(cfg.analysisBudget.limits.chunkInputTokens * 0.6),
  );
  const batches = localPlanBatches(cfg, result.facts, cap);
  assert.ok(batches.length > 1);
  assert.equal(batches.flat().length, result.facts.length);
  assert.ok(batches.every((batch) => batch.length <= cfg.splitMaxPlanFiles));
  assert.ok(batches.every((batch) => Buffer.byteLength(JSON.stringify(batch)) <= cap));
  const compacted = compactLocalPlanFacts(cfg, result.facts);
  const compactBatches = localPlanBatches(cfg, compacted.facts, cap);
  const originalBytes = batches.reduce(
    (total, batch) => total + Buffer.byteLength(JSON.stringify(batch)),
    0,
  );
  const compactBytes = compactBatches.reduce(
    (total, batch) => total + Buffer.byteLength(JSON.stringify(batch)),
    0,
  );
  assert.equal(compacted.originalCandidates, 10000);
  assert.ok(compacted.planningCandidates <= cfg.splitMaxPlanFiles * 2 + 16);
  assert.equal(new Set(compacted.facts.flatMap((fact) => fact.files)).size, 10000);
  const testBundle = compacted.facts.find((fact) => fact.files.includes('tests/中文.test.js'));
  assert.equal(testBundle.kind, 'test');
  assert.deepEqual(testBundle.files, ['tests/中文.test.js']);
  assert.ok(compactBytes < originalBytes / 20);
  assert.ok(compactBatches.flat().filter((item) => item.representativeExcerpt).length <= 16);
  assert.equal(calls(), 0);
  assert.equal(cfg.analysisBudget.snapshot().requests, 0);
});

test(
  'untracked snapshots stay readable under a hard 128-descriptor limit',
  { skip: process.platform === 'win32' },
  (t) => {
    const cwd = mkdtempSync(join(tmpdir(), 'aicommit-fd-test-'));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const files = Array.from({ length: 180 }, (_, i) => ({ path: `file-${i}.js`, status: '??' }));
    for (const file of files)
      writeFileSync(join(cwd, file.path), 'const snapshot = true;\n'.repeat(150));
    const script = `
    import { captureUntrackedSnapshots } from ${JSON.stringify(new URL('../src/split.js', import.meta.url).href)};
    import { cleanupGitSpools } from ${JSON.stringify(new URL('../src/git-spool.js', import.meta.url).href)};
    const files = ${JSON.stringify(files)};
    try {
      const result = captureUntrackedSnapshots(process.cwd(), files);
      let readable = 0;
      for (const full of result.previews.sources.values()) {
        if (full.source.text(10000).includes('const snapshot = true;')) readable++;
        // Early generator cancellation must also close its read descriptor.
        for (const buffer of full.source.buffers()) { if (buffer.length) break; }
      }
      console.log(JSON.stringify({ findings: result.findings, readable }));
    } finally { cleanupGitSpools(); }
  `;
    const output = execFileSync(
      '/bin/sh',
      [
        '-c',
        'ulimit -n 128 && ulimit -H -n 128 && exec "$@"',
        'aicommit-fd-test',
        process.execPath,
        '--input-type=module',
        '-e',
        script,
      ],
      { cwd, encoding: 'utf8' },
    );
    assert.deepEqual(JSON.parse(output), { findings: [], readable: 180 });
  },
);
