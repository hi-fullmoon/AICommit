import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_CONFIG, validateConfig } from '../src/config.js';
import { getIndexFingerprint } from '../src/git.js';
import { getStagedChangedFiles, captureUntrackedSnapshots } from '../src/split.js';
import { cleanupGitSpools, spoolGit } from '../src/git-spool.js';
import {
  captureChanges,
  needsAnalysis,
  analysisConfig,
  analyzeChanges,
  summarizeChanges,
  planAnalyzedChanges,
  validatePartition,
} from '../src/change-analysis.js';
import { createAnalysisBudget } from '../src/analysis-budget.js';
import { requestGeneration } from '../src/model-client.js';
import { decodeUntrustedData } from '../src/trust.js';
import { generateCommitMessage } from '../src/api.js';
import { localInputBytes } from '../src/local-analysis.js';

function repo(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'aicommit-analysis-test-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  t.after(() => {
    cleanupGitSpools();
    rmSync(cwd, { recursive: true, force: true });
  });
  return { cwd, git };
}

function config(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    apiUrl: 'http://localhost:12345/v1/chat/completions',
    modelId: 'test-model',
    apiKey: '',
    reasoning: { ...DEFAULT_CONFIG.reasoning, mode: 'off' },
    largeChange: { ...DEFAULT_CONFIG.largeChange, strategy: 'deep' },
    ...overrides,
  };
}

function mockModel(t, transform = null) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    calls.push(payload);
    const dataMessage = payload.messages.find(
      (message) =>
        message.role === 'user' && message.content.startsWith('BEGIN_AICOMMIT_UNTRUSTED_JSON'),
    );
    if (!dataMessage)
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: 'chore: update generated assets' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        }),
      );
    const items = JSON.parse(decodeUntrustedData(dataMessage.content).content);
    let result;
    if (payload.messages[0].content.includes('Group related changes')) {
      result = [
        {
          ids: items.map((x) => x.id),
          summary: 'Add related fixture behavior and tests',
          subject: 'feat: add fixture behavior',
        },
      ];
    } else {
      result = [
        {
          ids: items.map((x) => x.id),
          summary: 'Add fixture behavior; no unsupported intent inferred.',
        },
      ];
    }
    if (payload.messages[0].content.includes('one entry per input ID'))
      result = items.map((item) => ({
        ids: [item.id],
        summary: 'Add fixture behavior; intent unspecified.',
      }));
    if (transform) result = transform(result, calls.length);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: typeof result === 'string' ? result : JSON.stringify(result) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      }),
    );
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

test('capture preserves Unicode, spaces, renames, and a stable binary fingerprint', (t) => {
  const { cwd, git } = repo(t);
  writeFileSync(join(cwd, '原始 file.js'), 'export const value = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'initial');
  renameSync(join(cwd, '原始 file.js'), join(cwd, '新 file.js'));
  writeFileSync(join(cwd, 'blob.bin'), Buffer.from([0, 255, 0, 1]));
  git('add', '-A');
  const capture = captureChanges([['diff', '--staged']], cwd, getStagedChangedFiles(cwd), config());
  const units = [...capture.units()];
  assert.equal(new Set(units.map((u) => u.fileId)).size, 2);
  assert.ok(capture.manifest.some((f) => f.addPaths.length === 2));
  const original = git('diff', '--staged', '--binary', '--full-index', '--no-ext-diff');
  assert.equal(getIndexFingerprint(cwd), createHash('sha256').update(original).digest('hex'));
});

test('large source is analyzed in chunks, then produces one summary or complete logical groups', async (t) => {
  const { cwd, git } = repo(t);
  for (let i = 0; i < 12; i++)
    writeFileSync(join(cwd, `part-${i}.js`), 'export const fixture = true;\n'.repeat(160));
  git('add', '-A');
  const cfg = analysisConfig(config());
  const capture = captureChanges(
    [['diff', '--staged', '--unified=1']],
    cwd,
    getStagedChangedFiles(cwd),
    cfg,
  );
  assert.equal(needsAnalysis(capture, cfg), true);
  const calls = mockModel(t);
  const analyzed = await analyzeChanges(cfg, capture);
  assert.equal(analyzed.coverage.analyzedFiles, 12);
  assert.equal(analyzed.coverage.failedFiles, 0);
  assert.ok(calls.length > 1);
  const initialCalls = calls.length;
  await analyzeChanges(cfg, capture);
  assert.equal(calls.length, initialCalls, 'completed fragments are reused within this snapshot');
  const summary = await summarizeChanges(cfg, analyzed.facts);
  assert.match(summary, /Structured change summaries/);
  const groups = await planAnalyzedChanges(cfg, analyzed.facts);
  assert.equal(new Set(groups.flatMap((g) => g.files)).size, 12);
  assert.equal(groups.length, 1);
  assert.equal(cfg.analysisBudget.snapshot().requests, calls.length);
  assert.equal(cfg.analysisBudget.snapshot().usage.totalTokens, calls.length * 140);
});

test('private key material found late in a large section prevents every fragment from being sent', async (t) => {
  const { cwd, git } = repo(t);
  writeFileSync(
    join(cwd, 'material.txt'),
    'sensitive-body-should-never-leave\n'.repeat(300) + '-----BEGIN PRIVATE KEY-----\nSECRET\n',
  );
  git('add', '-A');
  const cfg = analysisConfig(config());
  const capture = captureChanges([['diff', '--staged']], cwd, getStagedChangedFiles(cwd), cfg);
  assert.ok(capture.findings.some((f) => f.includes('private-key')));
  const calls = mockModel(t);
  const result = await analyzeChanges(cfg, capture);
  assert.equal(result.coverage.metadataOnlyFiles, 1);
  assert.equal(calls.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /sensitive-body-should-never-leave|SECRET/);
});

test('full untracked snapshot survives later worktree edits and is analyzed beyond the preview', async (t) => {
  const { cwd } = repo(t);
  const path = 'new.js';
  writeFileSync(join(cwd, path), 'const original = true;\n'.repeat(200) + 'const tail = 42;\n');
  const files = [{ path, status: '??', addPaths: [path] }];
  const snapshot = captureUntrackedSnapshots(cwd, files);
  const cfg = analysisConfig(config());
  const capture = captureChanges([['diff', '--cached']], cwd, files, cfg);
  writeFileSync(join(cwd, path), 'changed after capture');
  const calls = mockModel(t);
  const result = await analyzeChanges(cfg, capture, true, snapshot.previews);
  assert.equal(result.coverage.analyzedFiles, 1);
  assert.match(JSON.stringify(calls), /tail = 42/);
  assert.doesNotMatch(JSON.stringify(calls), /changed after capture/);
});

test('invalid model membership never produces a usable analysis', async (t) => {
  const { cwd, git } = repo(t);
  writeFileSync(join(cwd, 'a.js'), 'const x = 1;\n'.repeat(300));
  git('add', '-A');
  const cfg = analysisConfig(config());
  const capture = captureChanges([['diff', '--staged']], cwd, getStagedChangedFiles(cwd), cfg);
  mockModel(t, (groups) => [{ ...groups[0], ids: ['unknown-id'] }]);
  await assert.rejects(analyzeChanges(cfg, capture), /duplicate or unknown/);
});

test('large-change analysis repairs malformed JSON with one corrective request', async (t) => {
  const { cwd, git } = repo(t);
  writeFileSync(join(cwd, 'a.js'), 'const x = 1;\n'.repeat(300));
  git('add', '-A');
  const cfg = analysisConfig(config());
  const capture = captureChanges([['diff', '--staged']], cwd, getStagedChangedFiles(cwd), cfg);
  const calls = mockModel(t, (groups, callCount) =>
    callCount === 1 ? 'I analyzed the change, but this is not JSON.' : groups,
  );

  const result = await analyzeChanges(cfg, capture);

  assert.equal(result.coverage.analyzedFiles, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages.at(-1).content, /incomplete or malformed/);
  assert.match(calls[1].messages.at(-1).content, /Required IDs/);
});

test('large-change analysis accepts a complete JSON array surrounded by provider prose', async (t) => {
  const { cwd, git } = repo(t);
  writeFileSync(join(cwd, 'a.js'), 'const x = 1;\n'.repeat(300));
  git('add', '-A');
  const cfg = analysisConfig(config());
  const capture = captureChanges([['diff', '--staged']], cwd, getStagedChangedFiles(cwd), cfg);
  const calls = mockModel(
    t,
    (groups) => `Here is the requested result:\n${JSON.stringify(groups)}\nDone.`,
  );

  const result = await analyzeChanges(cfg, capture);

  assert.equal(result.coverage.analyzedFiles, 1);
  assert.equal(calls.length, 1);
});

test('partitions reject omissions, duplicate IDs, and malformed summaries', () => {
  assert.throws(() => validatePartition([{ ids: ['a'], summary: 'x' }], ['a', 'b']), /unassigned/);
  assert.throws(() => validatePartition([{ ids: ['a', 'a'], summary: 'x' }], ['a']), /duplicate/);
  assert.throws(() => validatePartition([{ ids: ['a'], summary: '' }], ['a']), /invalid/);
});

test('budgets reserve before dispatch, include retries, and stop without another network call', async (t) => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('busy', { status: 429 });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const budget = createAnalysisBudget({
    chunkInputTokens: 1024,
    maxTotalTokens: 150,
    timeoutMs: 10000,
  });
  await assert.rejects(
    requestGeneration(
      config({ analysisBudget: budget, retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } }),
      { messages: [{ role: 'user', content: 'test' }], maxTokens: 100, temperature: 0 },
    ),
    /budget/,
  );
  assert.equal(calls, 1);
  assert.equal(budget.snapshot().requests, 1);
});

test('unknown token usage keeps the reservation and oversized requests are rejected', () => {
  const budget = createAnalysisBudget({ chunkInputTokens: 100, maxTotalTokens: 300 });
  const ticket = budget.reserve(50, 100);
  budget.settle(ticket, null);
  assert.equal(budget.snapshot().budgetedTokens, 150);
  assert.throws(() => budget.reserve(101, 0), /chunkInputTokens/);
});

test('Git spools handle output beyond the former buffer ceiling without returning full text', (t) => {
  const { cwd, git } = repo(t);
  writeFileSync(join(cwd, 'large.txt'), 'bounded line\n'.repeat(5_600_000));
  git('add', '-A');
  const source = spoolGit([['diff', '--staged']], cwd);
  assert.ok(source.size > 64 * 1024 * 1024);
  assert.equal(source.text(30000), null);
  const hash = createHash('sha256');
  for (const buffer of source.buffers()) {
    assert.ok(buffer.length <= 65536);
    hash.update(buffer);
  }
  assert.match(hash.digest('hex'), /^[0-9a-f]{64}$/);
  assert.match(getIndexFingerprint(cwd), /^[0-9a-f]{64}$/);
});

test('extreme single lines fail explicitly rather than silently truncating', (t) => {
  const { cwd } = repo(t);
  const source = spoolGit([], cwd);
  source.append(Buffer.alloc(1024 * 1024 + 1, 65));
  assert.throws(() => [...source.lines()], /line exceeds/);
});

test('ten thousand generated files finish local reduction and generation with one provider call', async (t) => {
  const { cwd, git } = repo(t);
  for (let i = 0; i < 10000; i++) writeFileSync(join(cwd, `${i}.map`), '{}\n');
  git('add', '-A');
  const cfg = analysisConfig(
    config({ language: 'en', stripFiles: ['*.map'], largeChange: { strategy: 'auto' } }),
  );
  const capture = captureChanges([['diff', '--staged']], cwd, getStagedChangedFiles(cwd), cfg);
  const calls = mockModel(t);
  const result = await analyzeChanges(cfg, capture);
  assert.equal(result.coverage.totalFiles, 10000);
  assert.equal(result.coverage.metadataOnlyFiles, 10000);
  assert.equal(new Set(result.facts.flatMap((fact) => fact.files)).size, 10000);
  assert.equal(calls.length, 0);
  const summary = await summarizeChanges(cfg, result.facts);
  assert.ok(Buffer.byteLength(summary) <= localInputBytes(cfg));
  assert.equal(JSON.parse(summary).totalFiles, 10000);
  assert.equal(calls.length, 0);
  const generated = await generateCommitMessage(cfg, summary);
  assert.equal(generated.message, 'chore: update generated assets');
  assert.equal(calls.length, 1);
});

test('largeChange configuration rejects unknown, invalid and contradictory limits', () => {
  assert.throws(() => validateConfig(config({ largeChange: { concurrency: 0 } })), /concurrency/);
  assert.throws(() => validateConfig(config({ largeChange: { extra: true } })), /unknown/);
  assert.throws(
    () => validateConfig(config({ largeChange: { maxTotalTokens: 1024 } })),
    /must cover/,
  );
  validateConfig(config({ largeChange: { concurrency: 1 } }));
  validateConfig(config({ largeChange: { strategy: 'deep' } }));
  assert.throws(
    () => validateConfig(config({ largeChange: { strategy: 'recursive' } })),
    /strategy/,
  );
});
