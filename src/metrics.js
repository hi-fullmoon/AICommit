import { appendFile, chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import chalk from 'chalk';

export const DEFAULT_METRICS = Object.freeze({
  enabled: true,
  path: '',
  maxEntries: 500,
});

let activeSettings = null;
const METRIC_RESULTS = new Set([
  'committed',
  'dry_run',
  'cancelled',
  'config',
  'git_state',
  'network',
  'provider',
  'response_format',
  'sensitive_data',
  'concurrent_modification',
  'internal',
  'unknown',
]);

export function metricsPath(settings = DEFAULT_METRICS, home = homedir()) {
  return settings.path || join(home, '.aicommit', 'metrics.jsonl');
}

export function configureMetrics(settings) {
  activeSettings = { ...DEFAULT_METRICS, ...settings };
}

function safeUsage(usage) {
  if (!usage) return null;
  const safe = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) {
    if (typeof usage[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0) {
      safe[key] = usage[key];
    }
  }
  return Object.keys(safe).length ? safe : null;
}

export function minimizeMetric(input = {}) {
  const result = METRIC_RESULTS.has(input.result) ? input.result : 'unknown';
  return {
    durationMs:
      typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
        ? Math.max(0, Math.round(input.durationMs))
        : null,
    usage: safeUsage(input.usage),
    result,
    edited: Boolean(input.edited),
    rewrites:
      Number.isInteger(input.rewrites) && input.rewrites >= 0 ? Math.min(input.rewrites, 1000) : 0,
  };
}

async function trimMetrics(path, maxEntries) {
  const text = await readFile(path, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  if (lines.length <= maxEntries) return;

  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, lines.slice(-maxEntries).join('\n') + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(tempPath, path);
    await chmod(path, 0o600).catch(() => {});
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    throw err;
  }
}

export async function recordMetric(input, settings = activeSettings) {
  if (!settings?.enabled) return false;
  const path = metricsPath(settings);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, JSON.stringify(minimizeMetric(input)) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(path, 0o600).catch(() => {});
  await trimMetrics(path, settings.maxEntries || DEFAULT_METRICS.maxEntries);
  return true;
}

async function readUserMetricsConfig(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Failed to read user config ${path}: ${err.message}`);
  }
}

async function writeUserConfig(path, config) {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(config, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(tempPath, path);
    await chmod(path, 0o600).catch(() => {});
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    throw err;
  }
}

async function metricCount(path) {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean).length;
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
}

export async function readMetricRecords(path) {
  let textValue;
  try {
    textValue = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { records: [], invalid: 0 };
    throw err;
  }
  const records = [];
  let invalid = 0;
  for (const line of textValue.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        invalid++;
        continue;
      }
      records.push(minimizeMetric(parsed));
    } catch {
      invalid++;
    }
  }
  return { records, invalid };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((sorted.length - 1) * ratio)];
}

function percent(part, whole) {
  return whole ? (part / whole) * 100 : null;
}

function relativeChange(previous, recent) {
  if (previous === null || recent === null || previous === 0) return null;
  return ((recent - previous) / previous) * 100;
}

function tokenTotal(record) {
  const usage = record.usage;
  if (!usage) return null;
  if (typeof usage.totalTokens === 'number') return usage.totalTokens;
  if (typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number') {
    return usage.inputTokens + usage.outputTokens;
  }
  return null;
}

function halves(records) {
  if (records.length < 2) return [[], records];
  const split = Math.floor(records.length / 2);
  return [records.slice(0, split), records.slice(split)];
}

function windowQuality(records) {
  const changed = records.filter((record) => record.edited || record.rewrites > 0).length;
  return { runs: records.length, changed, rate: percent(changed, records.length) };
}

export function summarizeMetrics(inputRecords) {
  const records = (inputRecords || []).map((record) => minimizeMetric(record));
  const successful = records.filter((record) => ['committed', 'dry_run'].includes(record.result));
  const failed = records.filter(
    (record) => !['committed', 'dry_run', 'cancelled'].includes(record.result),
  );
  const edited = records.filter((record) => record.edited);
  const rewritten = records.filter((record) => record.rewrites > 0);
  const acceptedFirstPass = successful.filter((record) => !record.edited && record.rewrites === 0);
  const durations = records
    .map((record) => record.durationMs)
    .filter((value) => typeof value === 'number');
  const tokens = records.map(tokenTotal).filter((value) => typeof value === 'number');
  const [previousRecords, recentRecords] = halves(records);
  const previousDurations = previousRecords
    .map((record) => record.durationMs)
    .filter((value) => typeof value === 'number');
  const recentDurations = recentRecords
    .map((record) => record.durationMs)
    .filter((value) => typeof value === 'number');
  const previousTokens = previousRecords
    .map(tokenTotal)
    .filter((value) => typeof value === 'number');
  const recentTokens = recentRecords.map(tokenTotal).filter((value) => typeof value === 'number');
  const [previousSuccess, recentSuccess] = halves(successful);
  const previousQuality = windowQuality(previousSuccess);
  const recentQuality = windowQuality(recentSuccess);
  const qualityImprovement =
    previousQuality.rate === null || recentQuality.rate === null || previousQuality.rate === 0
      ? null
      : ((previousQuality.rate - recentQuality.rate) / previousQuality.rate) * 100;

  return {
    runs: records.length,
    outcomes: {
      committed: records.filter((record) => record.result === 'committed').length,
      dryRuns: records.filter((record) => record.result === 'dry_run').length,
      acceptedFirstPass: acceptedFirstPass.length,
      edited: edited.length,
      rewritten: rewritten.length,
      rewriteCount: records.reduce((sum, record) => sum + record.rewrites, 0),
      failed: failed.length,
      cancelled: records.filter((record) => record.result === 'cancelled').length,
    },
    rates: {
      firstPassAcceptance: percent(acceptedFirstPass.length, successful.length),
      editOrRewrite: percent(
        successful.filter((record) => record.edited || record.rewrites > 0).length,
        successful.length,
      ),
      failure: percent(failed.length, records.length),
    },
    latency: {
      count: durations.length,
      averageMs: average(durations),
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      previousAverageMs: average(previousDurations),
      recentAverageMs: average(recentDurations),
      relativeChangePercent: relativeChange(average(previousDurations), average(recentDurations)),
    },
    tokens: {
      count: tokens.length,
      total: tokens.reduce((sum, value) => sum + value, 0),
      average: average(tokens),
      previousAverage: average(previousTokens),
      recentAverage: average(recentTokens),
      relativeChangePercent: relativeChange(average(previousTokens), average(recentTokens)),
    },
    qualityTrend: {
      baselineReady: previousSuccess.length >= 5 && recentSuccess.length >= 5,
      previous: previousQuality,
      recent: recentQuality,
      relativeImprovementPercent: qualityImprovement,
      targetMet: qualityImprovement !== null && qualityImprovement >= 20,
    },
  };
}

function renderPercent(value) {
  return value === null ? 'n/a' : `${value.toFixed(1)}%`;
}

function renderDuration(value) {
  if (value === null) return 'n/a';
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
}

function renderNumber(value) {
  return value === null ? 'n/a' : Math.round(value).toLocaleString('en-US');
}

export async function runStatsCommand(action = 'show', options = {}) {
  if (['clear', 'enable', 'disable'].includes(action)) {
    return updateMetrics(action, options);
  }
  const home = options.home || homedir();
  const userConfigPath = options.userConfigPath || join(home, '.aicommit.config.json');
  const existing = await readUserMetricsConfig(userConfigPath);
  const settings = { ...DEFAULT_METRICS, ...existing.metrics };
  const path = metricsPath(settings, home);
  const { records, invalid } = await readMetricRecords(path);
  const stats = summarizeMetrics(records);

  console.log('');
  console.log('  ' + chalk.cyan.bold('Local quality stats'));
  console.log(`  Status:      ${settings.enabled ? 'enabled' : 'disabled'}`);
  console.log(
    `  Runs:        ${stats.runs}${invalid ? ` (${invalid} invalid line(s) ignored)` : ''}`,
  );
  console.log(
    `  First pass:  ${stats.outcomes.acceptedFirstPass} (${renderPercent(stats.rates.firstPassAcceptance)})`,
  );
  console.log(`  Edited:      ${stats.outcomes.edited}`);
  console.log(
    `  Rewritten:   ${stats.outcomes.rewritten} run(s), ${stats.outcomes.rewriteCount} rewrite(s)`,
  );
  console.log(`  Failed:      ${stats.outcomes.failed} (${renderPercent(stats.rates.failure)})`);
  console.log(
    `  Latency:     P50 ${renderDuration(stats.latency.p50Ms)}, P95 ${renderDuration(stats.latency.p95Ms)}, ` +
      `recent ${renderPercent(stats.latency.relativeChangePercent)}`,
  );
  console.log(
    `  Tokens:      total ${renderNumber(stats.tokens.total)}, average ${renderNumber(stats.tokens.average)}, ` +
      `recent ${renderPercent(stats.tokens.relativeChangePercent)}`,
  );
  if (stats.qualityTrend.baselineReady) {
    console.log(
      `  Edit/rewrite: previous ${renderPercent(stats.qualityTrend.previous.rate)} → ` +
        `recent ${renderPercent(stats.qualityTrend.recent.rate)}; relative improvement ` +
        `${renderPercent(stats.qualityTrend.relativeImprovementPercent)} ` +
        `(20% target ${stats.qualityTrend.targetMet ? 'met' : 'not yet met'})`,
    );
  } else {
    console.log(
      '  Edit/rewrite: collect at least 10 successful runs to establish two baseline windows',
    );
  }
  console.log(`  Path:        ${path}`);
  console.log(
    '  Privacy:     local only; no messages, diffs, reasoning, file names, providers, or models',
  );
  console.log('');
  return { action, path, enabled: settings.enabled, invalid, stats };
}

async function updateMetrics(action, options = {}) {
  const home = options.home || homedir();
  const userConfigPath = options.userConfigPath || join(home, '.aicommit.config.json');
  const existing = await readUserMetricsConfig(userConfigPath);
  const settings = { ...DEFAULT_METRICS, ...existing.metrics };
  const path = metricsPath(settings, home);

  if (action === 'clear') {
    const count = await metricCount(path);
    await unlink(path).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
    console.log(
      `  ${chalk.green('✓')} Cleared ${count} local metric record(s): ${path} ` +
        chalk.dim('(cannot be recovered)'),
    );
    return { action, count, path, enabled: settings.enabled };
  }

  if (action === 'enable' || action === 'disable') {
    const enabled = action === 'enable';
    const updated = {
      ...existing,
      metrics: { ...existing.metrics, enabled },
    };
    await writeUserConfig(userConfigPath, updated);
    console.log(`  ${chalk.green('✓')} Local metrics ${enabled ? 'enabled' : 'disabled'}.`);
    return { action, count: await metricCount(path), path, enabled };
  }

  throw new Error(`Unsupported stats action: ${action}`);
}
