import { classifyError, EXIT_CODES } from './errors.js';

export const OUTPUT_SCHEMA_VERSION = '1.0';

function normalizedUsage(usage) {
  if (!usage) return null;
  const value = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) {
    if (typeof usage[key] === 'number' && Number.isFinite(usage[key])) value[key] = usage[key];
  }
  return Object.keys(value).length ? value : null;
}

function normalizedPlan(plan) {
  if (!Array.isArray(plan)) return null;
  return plan.map((item) => ({
    message: String(item?.message || ''),
    files: Array.isArray(item?.files) ? item.files.map(String) : [],
  }));
}

export function successOutput(result = {}) {
  return {
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    ok: true,
    message: typeof result.message === 'string' ? result.message : null,
    plan: normalizedPlan(result.plan),
    provider: result.provider || null,
    model: result.model || null,
    latencyMs:
      typeof result.latencyMs === 'number' && Number.isFinite(result.latencyMs)
        ? result.latencyMs
        : null,
    usage: normalizedUsage(result.usage),
    warnings: Array.isArray(result.warnings) ? result.warnings.map(String) : [],
    exitReason: result.exitReason || 'success',
    committed: Boolean(result.committed),
    error: null,
  };
}

export function errorOutput(err) {
  const classified = classifyError(err);
  return {
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    ok: false,
    message: null,
    plan: null,
    provider: null,
    model: null,
    latencyMs: null,
    usage: null,
    warnings: [],
    exitReason: classified.category,
    committed: false,
    error: {
      category: classified.category,
      message: classified.message,
    },
  };
}

export function exitCodeFor(err) {
  return classifyError(err).exitCode ?? EXIT_CODES.internal;
}

export function isJsonOutputRequested(args = process.argv.slice(2)) {
  return args.some(
    (arg, index) => arg === '--output=json' || (arg === '--output' && args[index + 1] === 'json'),
  );
}
