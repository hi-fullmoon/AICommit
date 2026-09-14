import { classifyError, EXIT_CODES } from './errors.js';

export const OUTPUT_SCHEMA_VERSION = '1.1';

function safeString(value) {
  return typeof value === 'string' && value ? value : null;
}

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
    ...(Array.isArray(item?.hunks)
      ? {
          hunks: item.hunks.map((assignment) => ({
            path: String(assignment?.path || ''),
            ids: Array.isArray(assignment?.ids) ? assignment.ids.map(String) : [],
          })),
        }
      : {}),
  }));
}

export function successOutput(result = {}) {
  const output = {
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
    commitState: result.commitState || (result.committed ? 'complete' : 'none'),
    commitSha: safeString(result.commitSha),
    planFile: safeString(result.planFile),
    scope: safeString(result.scope),
    changeCount: Number.isInteger(result.changeCount) ? result.changeCount : null,
    error: null,
  };
  if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
    output.data = result.data;
  }
  return output;
}

export function errorOutput(err) {
  const classified = classifyError(err);
  const output = {
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
    committed: classified.committed,
    commitState: classified.commitState,
    commitSha: null,
    planFile: null,
    scope: null,
    changeCount: null,
    error: {
      category: classified.category,
      code: classified.code,
      message: classified.message,
      retryable: classified.retryable,
      nextAction: classified.nextAction,
    },
  };
  if (classified.data && typeof classified.data === 'object' && !Array.isArray(classified.data)) {
    output.data = classified.data;
  }
  return output;
}

export function exitCodeFor(err) {
  return classifyError(err).exitCode ?? EXIT_CODES.internal;
}

export function isJsonOutputRequested(args = process.argv.slice(2)) {
  return args.some(
    (arg, index) => arg === '--output=json' || (arg === '--output' && args[index + 1] === 'json'),
  );
}
