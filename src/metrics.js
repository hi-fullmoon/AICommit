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

export async function runMetricsCommand(action = 'status', options = {}) {
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

  const count = await metricCount(path);
  console.log('');
  console.log('  ' + chalk.cyan.bold('Local metrics'));
  console.log(`  Status:  ${settings.enabled ? 'enabled' : 'disabled'}`);
  console.log(`  Records: ${count}`);
  console.log(`  Path:    ${path}`);
  console.log('  Upload:  disabled (no upload implementation)');
  console.log('');
  return { action, count, path, enabled: settings.enabled };
}
