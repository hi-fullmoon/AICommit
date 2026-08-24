import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  minimizeMetric,
  readMetricRecords,
  recordMetric,
  runMetricsCommand,
  runStatsCommand,
  summarizeMetrics,
} from '../src/metrics.js';

test('metric minimization uses a strict privacy allowlist', () => {
  const metric = minimizeMetric({
    durationMs: 12.8,
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, vendor: 99 },
    result: 'feat: private commit message',
    edited: true,
    rewrites: 2,
    message: 'feat: private commit message',
    diff: '+secret',
    reasoning: 'private trace',
    files: ['secret.js'],
    provider: 'private-provider',
    model: 'private-model',
  });

  assert.deepEqual(metric, {
    durationMs: 13,
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    result: 'unknown',
    edited: true,
    rewrites: 2,
  });
  assert.deepEqual(Object.keys(metric), ['durationMs', 'usage', 'result', 'edited', 'rewrites']);
  assert.doesNotMatch(JSON.stringify(metric), /private|secret|message|diff|reasoning|files/);
});

test('local metric writer uses mode 0600, honors retention, and never writes when disabled', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-metrics-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'private', 'metrics.jsonl');
  const settings = { enabled: true, path, maxEntries: 2 };

  await recordMetric({ durationMs: 1, result: 'committed' }, settings);
  await recordMetric({ durationMs: 2, result: 'dry_run' }, settings);
  await recordMetric({ durationMs: 3, result: 'provider' }, settings);
  const records = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => record.result),
    ['dry_run', 'provider'],
  );
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);

  const disabledPath = join(root, 'disabled.jsonl');
  assert.equal(
    await recordMetric(
      { durationMs: 4, result: 'committed' },
      { enabled: false, path: disabledPath, maxEntries: 2 },
    ),
    false,
  );
  assert.equal(existsSync(disabledPath), false);
});

test('metrics command can disable, enable, inspect, and irreversibly clear local records', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-metrics-command-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userConfigPath = join(root, '.aicommit.config.json');
  const metricsFile = join(root, 'metrics.jsonl');
  await writeFile(
    userConfigPath,
    JSON.stringify({ metrics: { enabled: true, path: metricsFile, maxEntries: 5 } }),
  );
  await recordMetric(
    { durationMs: 5, result: 'committed' },
    { enabled: true, path: metricsFile, maxEntries: 5 },
  );

  const disabled = await runMetricsCommand('disable', { home: root, userConfigPath });
  assert.equal(disabled.enabled, false);
  assert.equal(JSON.parse(await readFile(userConfigPath, 'utf8')).metrics.enabled, false);

  const enabled = await runMetricsCommand('enable', { home: root, userConfigPath });
  assert.equal(enabled.enabled, true);
  const status = await runMetricsCommand('status', { home: root, userConfigPath });
  assert.equal(status.count, 1);

  const cleared = await runMetricsCommand('clear', { home: root, userConfigPath });
  assert.equal(cleared.count, 1);
  assert.equal(existsSync(metricsFile), false);
});

test('stats summarizes acceptance, edits, rewrites, failures, latency, tokens, and quality trend', () => {
  const successful = [
    { result: 'committed', edited: true, rewrites: 0, durationMs: 100, usage: { totalTokens: 10 } },
    {
      result: 'committed',
      edited: false,
      rewrites: 1,
      durationMs: 200,
      usage: { totalTokens: 20 },
    },
    { result: 'dry_run', edited: true, rewrites: 1, durationMs: 300, usage: { totalTokens: 30 } },
    {
      result: 'committed',
      edited: false,
      rewrites: 0,
      durationMs: 400,
      usage: { totalTokens: 40 },
    },
    {
      result: 'committed',
      edited: false,
      rewrites: 0,
      durationMs: 500,
      usage: { totalTokens: 50 },
    },
    {
      result: 'committed',
      edited: false,
      rewrites: 1,
      durationMs: 600,
      usage: { totalTokens: 60 },
    },
    {
      result: 'committed',
      edited: false,
      rewrites: 0,
      durationMs: 700,
      usage: { totalTokens: 70 },
    },
    { result: 'dry_run', edited: false, rewrites: 0, durationMs: 800, usage: { totalTokens: 80 } },
    {
      result: 'committed',
      edited: false,
      rewrites: 0,
      durationMs: 900,
      usage: { totalTokens: 90 },
    },
    {
      result: 'committed',
      edited: false,
      rewrites: 0,
      durationMs: 1000,
      usage: { totalTokens: 100 },
    },
  ];
  const stats = summarizeMetrics([
    ...successful,
    { result: 'provider', edited: false, rewrites: 0, durationMs: 1100, usage: null },
  ]);
  assert.equal(stats.runs, 11);
  assert.equal(stats.outcomes.committed, 8);
  assert.equal(stats.outcomes.dryRuns, 2);
  assert.equal(stats.outcomes.acceptedFirstPass, 6);
  assert.equal(stats.outcomes.edited, 2);
  assert.equal(stats.outcomes.rewritten, 3);
  assert.equal(stats.outcomes.rewriteCount, 3);
  assert.equal(stats.outcomes.failed, 1);
  assert.equal(stats.latency.p50Ms, 600);
  assert.equal(stats.latency.p95Ms, 1100);
  assert.equal(stats.tokens.total, 550);
  assert.equal(stats.qualityTrend.baselineReady, true);
  assert.equal(stats.qualityTrend.previous.rate, 60);
  assert.equal(stats.qualityTrend.recent.rate, 20);
  assert.ok(stats.qualityTrend.relativeImprovementPercent > 66);
  assert.equal(stats.qualityTrend.targetMet, true);
});

test('stats command ignores malformed lines and reuses enable, disable, and clear controls', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-stats-command-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userConfigPath = join(root, '.aicommit.config.json');
  const metricsFile = join(root, 'metrics.jsonl');
  await writeFile(
    userConfigPath,
    JSON.stringify({ metrics: { enabled: true, path: metricsFile, maxEntries: 20 } }),
  );
  await writeFile(
    metricsFile,
    JSON.stringify(minimizeMetric({ result: 'committed', durationMs: 25 })) +
      '\n{malformed\n' +
      JSON.stringify({ message: 'private', result: 'committed', durationMs: 35 }) +
      '\n',
  );
  const loaded = await readMetricRecords(metricsFile);
  assert.equal(loaded.records.length, 2);
  assert.equal(loaded.invalid, 1);
  assert.doesNotMatch(JSON.stringify(loaded.records), /private|message/);

  const report = await runStatsCommand('show', { home: root, userConfigPath });
  assert.equal(report.invalid, 1);
  assert.equal(report.stats.runs, 2);
  assert.equal(report.stats.outcomes.acceptedFirstPass, 2);
  assert.equal((await runStatsCommand('disable', { home: root, userConfigPath })).enabled, false);
  assert.equal((await runStatsCommand('enable', { home: root, userConfigPath })).enabled, true);
  assert.equal((await runStatsCommand('clear', { home: root, userConfigPath })).count, 3);
  assert.equal(existsSync(metricsFile), false);
});
