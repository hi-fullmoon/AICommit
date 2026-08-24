import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { minimizeMetric, recordMetric, runMetricsCommand } from '../src/metrics.js';

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
