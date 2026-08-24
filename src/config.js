import { readFile, chmod } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import chalk from 'chalk';

import { fileExists, deepMerge } from './utils.js';
import { ERROR_CATEGORIES, fail } from './errors.js';
import { resolveCredential } from './credentials.js';
import { DEFAULT_METRICS } from './metrics.js';
import { DEFAULT_COMMIT_POLICY, mergeCommitPolicy, validateCommitPolicyConfig } from './policy.js';
import {
  DEFAULT_REPOSITORY_CONTEXT,
  filterProjectRepositoryContext,
  mergeRepositoryContext,
  validateRepositoryContextConfig,
} from './context.js';
import { readTeamPolicy } from './team-policy.js';

// Repository-owned config is untrusted input: a cloned repository must never
// be able to redirect requests while inheriting the API key from the user's
// global config. Project config may tune generation/display behaviour, but all
// connection and provider selection fields remain user-owned.
export const PROJECT_CONNECTION_KEYS = new Set([
  'apiUrl',
  'apiKey',
  'apiKeyEnv',
  'modelId',
  'providerType',
  'providers',
  'defaultProvider',
  'extraBody',
  'retry',
  'credentialHelper',
  'metrics',
  'allowProjectPrompt',
]);

const PROJECT_SAFE_KEYS = new Set([
  'language',
  'commitPolicy',
  'repositoryContext',
  'prompt',
  'stripFiles',
  'temperature',
  'maxTokens',
  'timeoutMs',
  'maxDiffChars',
  'maxFileDiffChars',
  'splitMaxDiffChars',
  'splitMaxPlanFiles',
  'diffContextLines',
]);
const PROJECT_CEILING_KEYS = new Set([
  'maxTokens',
  'timeoutMs',
  'maxDiffChars',
  'maxFileDiffChars',
  'splitMaxDiffChars',
  'splitMaxPlanFiles',
  'diffContextLines',
]);
const MAX_PROJECT_PROMPT_CHARS = 20_000;

export function filterProjectConfig(projectConfig, baseConfig = DEFAULT_CONFIG) {
  if (!projectConfig || typeof projectConfig !== 'object' || Array.isArray(projectConfig)) {
    throw new Error('expected a JSON object');
  }

  const safe = {};
  const ignored = [];
  for (const [key, value] of Object.entries(projectConfig)) {
    if (PROJECT_CONNECTION_KEYS.has(key) || !PROJECT_SAFE_KEYS.has(key)) {
      ignored.push(key);
      continue;
    }
    if (
      key === 'prompt' &&
      (!baseConfig.allowProjectPrompt ||
        typeof value !== 'string' ||
        value.length > MAX_PROJECT_PROMPT_CHARS)
    ) {
      ignored.push(key);
      continue;
    }
    if (key === 'repositoryContext') {
      const filtered = filterProjectRepositoryContext(value, baseConfig.repositoryContext);
      if (filtered.safe && Object.keys(filtered.safe).length) safe[key] = filtered.safe;
      ignored.push(...filtered.ignored);
      continue;
    }
    if (
      PROJECT_CEILING_KEYS.has(key) &&
      typeof value === 'number' &&
      typeof baseConfig[key] === 'number' &&
      value > baseConfig[key]
    ) {
      ignored.push(key);
      continue;
    }
    safe[key] = value;
  }
  return { safe, ignored };
}

export const DEFAULT_CONFIG = {
  apiUrl: 'https://api.openai.com/v1/chat/completions',
  apiKey: '',
  apiKeyEnv: '',
  modelId: 'gpt-4o',
  // Optional explicit adapter selection. An empty value uses endpoint-based
  // detection; provider presets can set this for custom domains.
  providerType: '',
  temperature: 0.3,
  language: 'zh', // 'zh' = Chinese, 'en' = English
  // Versioned, structured rules replace the old hard-coded prompt contract.
  // A user prompt may add guidance, but cannot replace these constraints.
  commitPolicy: DEFAULT_COMMIT_POLICY,
  repositoryContext: DEFAULT_REPOSITORY_CONTEXT,
  // Repository-owned prompt text is executable model guidance, so it is
  // ignored unless the user explicitly opts in from their home config.
  allowProjectPrompt: false,
  maxTokens: 1024,
  // Per-request timeout in milliseconds — a hung endpoint aborts with a clear
  // error instead of leaving the spinner running forever.
  timeoutMs: 120000,
  // Retry only transient transport failures, rate limits, and recoverable
  // server errors. Authentication, parameter, and safety errors fail once.
  retry: {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 5000,
  },
  // Opt in to the user's configured Git credential helper, which commonly
  // delegates to macOS Keychain, Windows Credential Manager, or libsecret.
  credentialHelper: {
    enabled: false,
    username: 'aicommit',
  },
  // Minimal local-only run metrics. There is deliberately no upload target.
  metrics: { ...DEFAULT_METRICS },
  // Cap on diff characters sent to the model per call. Oversized diffs are
  // condensed to a `git diff --stat` summary plus truncated hunks, so a huge
  // change set doesn't burn tokens on lines the model doesn't need.
  maxDiffChars: 30000,
  // Cap on a single file's diff section. One huge file (e.g. a new generated
  // asset) is truncated to its header and leading hunks instead of eating
  // the whole maxDiffChars budget and pushing every other file out.
  maxFileDiffChars: 3000,
  // Split-mode planning has its own tighter prompt budget: it needs enough
  // context to group files, not the full detail needed to write the final
  // message for one commit.
  splitMaxDiffChars: 16000,
  splitMaxPlanFiles: 100,
  // Context lines around each diff hunk (git diff --unified=<n>). Fewer lines
  // means fewer tokens; 1 is enough for a commit message — git's default of
  // 3 mostly pays for context the model doesn't need.
  diffContextLines: 1,
  // Extra files to stub out of the diff like lock files, matched by basename
  // with "*" wildcards (e.g. ["*.min.js", "*.map", "*.snap"]). Generated
  // artifacts carry no commit intent but can be enormous.
  stripFiles: [],
  // false (default): regenerate rewords the previous message without
  // re-sending the diff — far cheaper. true: re-send the full diff on every
  // regenerate, for more varied rewrites at a much higher token cost.
  regenerateWithDiff: false,
  // Provider-specific request fields are opt-in. Keeping this empty by
  // default preserves compatibility with strict OpenAI-compatible servers.
  extraBody: {},
  // Cross-provider reasoning controls. Reasoning defaults to "on" and is
  // streamed automatically; "auto" preserves the provider/model default,
  // while --no-reasoning switches it to "off". There is no separate display
  // switch.
  reasoning: {
    mode: 'on',
    effort: 'medium',
    maxTokens: 4096,
    maxDisplayChars: 12000,
  },
  // Optional user-approved guidance appended to the structured policy.
  prompt: '',
};

function mergeConfig(base, override) {
  const merged = deepMerge(base, override);
  if (Object.hasOwn(override, 'commitPolicy')) {
    merged.commitPolicy = mergeCommitPolicy(base.commitPolicy, override.commitPolicy);
  }
  if (Object.hasOwn(override, 'repositoryContext')) {
    merged.repositoryContext = mergeRepositoryContext(
      base.repositoryContext,
      override.repositoryContext,
    );
  }
  return merged;
}

// Resolve the final flat config from a merged config that may contain a
// "providers" map: pick `cliProvider` → config.defaultProvider → first
// provider key, deep-merge that entry over the top-level values, then drop
// the providers/defaultProvider keys so downstream code sees a plain flat
// config.
function resolveProvider(config, cliProvider) {
  const providers = config.providers;

  if (cliProvider && !providers) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      `-p/--provider given ("${cliProvider}") but no "providers" defined in config. ` +
        'Define a "providers" map in ~/.aicommit.config.json.',
    );
  }

  if (!providers || typeof providers !== 'object' || Object.keys(providers).length === 0) {
    return { config, providerName: null };
  }

  const name = cliProvider || config.defaultProvider || Object.keys(providers)[0];

  if (!providers[name]) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      `Unknown provider: "${name}". Available providers: ${Object.keys(providers).join(', ')}`,
    );
  }

  const resolved = mergeConfig(config, providers[name]);
  delete resolved.providers;
  delete resolved.defaultProvider;
  return { config: resolved, providerName: name };
}

function assertString(config, key) {
  if (typeof config[key] !== 'string' || !config[key].trim()) {
    throw new Error(`Invalid config "${key}": expected a non-empty string.`);
  }
}

export function isSecureApiUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const loopback =
      u.hostname === 'localhost' ||
      u.hostname === '127.0.0.1' ||
      u.hostname.startsWith('127.') ||
      u.hostname === '[::1]';
    return u.protocol === 'https:' || loopback;
  } catch {
    return false;
  }
}

function assertUrl(config, key) {
  assertString(config, key);
  if (!isSecureApiUrl(config[key])) {
    throw new Error(
      `Invalid config "${key}": expected an HTTPS URL, or HTTP only for localhost/loopback.`,
    );
  }
}

function assertNumber(config, key, { integer = false, min = -Infinity, max = Infinity } = {}) {
  const value = config[key];
  const ok =
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (!integer || Number.isInteger(value)) &&
    value >= min &&
    value <= max;
  if (!ok) {
    const kind = integer ? 'integer' : 'number';
    const range = Number.isFinite(max) ? ` between ${min} and ${max}` : ` >= ${min}`;
    throw new Error(`Invalid config "${key}": expected a ${kind}${range}.`);
  }
}

export function validateConfig(config) {
  assertUrl(config, 'apiUrl');
  assertString(config, 'modelId');
  if (typeof config.prompt !== 'string' || config.prompt.length > 100_000) {
    throw new Error('Invalid config "prompt": expected a string of at most 100000 characters.');
  }
  if (typeof config.allowProjectPrompt !== 'boolean') {
    throw new Error('Invalid config "allowProjectPrompt": expected a boolean.');
  }
  validateCommitPolicyConfig(config.commitPolicy);
  validateRepositoryContextConfig(config.repositoryContext);

  if (typeof config.apiKey !== 'string') {
    throw new Error(
      'Invalid config "apiKey": expected a string. Use "" for keyless local endpoints.',
    );
  }
  if (
    typeof config.providerType !== 'string' ||
    !['', 'openai', 'openrouter', 'deepseek', 'minimax', 'ollama', 'custom'].includes(
      config.providerType.toLowerCase(),
    )
  ) {
    throw new Error(
      'Invalid config "providerType": expected openai, openrouter, deepseek, minimax, ollama, custom, or "".',
    );
  }
  if (!config.metrics || typeof config.metrics !== 'object' || Array.isArray(config.metrics)) {
    throw new Error('Invalid config "metrics": expected an object.');
  }
  if (typeof config.metrics.enabled !== 'boolean') {
    throw new Error('Invalid config "metrics.enabled": expected a boolean.');
  }
  if (
    typeof config.metrics.path !== 'string' ||
    (config.metrics.path && !isAbsolute(config.metrics.path))
  ) {
    throw new Error('Invalid config "metrics.path": expected an absolute path or "".');
  }
  if (
    typeof config.apiKeyEnv !== 'string' ||
    (config.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv))
  ) {
    throw new Error('Invalid config "apiKeyEnv": expected an environment variable name or "".');
  }
  if (config.language !== 'zh' && config.language !== 'en') {
    throw new Error(`Invalid config "language": expected "zh" or "en", got "${config.language}".`);
  }
  if (typeof config.regenerateWithDiff !== 'boolean') {
    throw new Error('Invalid config "regenerateWithDiff": expected a boolean.');
  }
  if (!Array.isArray(config.stripFiles) || config.stripFiles.some((p) => typeof p !== 'string')) {
    throw new Error('Invalid config "stripFiles": expected an array of strings.');
  }
  if (
    !config.extraBody ||
    typeof config.extraBody !== 'object' ||
    Array.isArray(config.extraBody)
  ) {
    throw new Error('Invalid config "extraBody": expected an object.');
  }
  if ('model' in config.extraBody || 'messages' in config.extraBody) {
    throw new Error('Invalid config "extraBody": "model" and "messages" are managed by aicommit.');
  }
  if (
    !config.reasoning ||
    typeof config.reasoning !== 'object' ||
    Array.isArray(config.reasoning)
  ) {
    throw new Error('Invalid config "reasoning": expected an object.');
  }
  if (!config.retry || typeof config.retry !== 'object' || Array.isArray(config.retry)) {
    throw new Error('Invalid config "retry": expected an object.');
  }
  if (
    !config.credentialHelper ||
    typeof config.credentialHelper !== 'object' ||
    Array.isArray(config.credentialHelper)
  ) {
    throw new Error('Invalid config "credentialHelper": expected an object.');
  }
  if (typeof config.credentialHelper.enabled !== 'boolean') {
    throw new Error('Invalid config "credentialHelper.enabled": expected a boolean.');
  }
  if (
    typeof config.credentialHelper.username !== 'string' ||
    !config.credentialHelper.username.trim() ||
    /[\r\n\0]/.test(config.credentialHelper.username)
  ) {
    throw new Error(
      'Invalid config "credentialHelper.username": expected a non-empty string without control characters.',
    );
  }
  if (!['auto', 'on', 'off'].includes(config.reasoning.mode)) {
    throw new Error('Invalid config "reasoning.mode": expected "auto", "on", or "off".');
  }
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(config.reasoning.effort)) {
    throw new Error(
      'Invalid config "reasoning.effort": expected low, medium, high, xhigh, or max.',
    );
  }
  for (const key of ['enabledBody', 'disabledBody']) {
    const value = config.reasoning[key];
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
      throw new Error(`Invalid config "reasoning.${key}": expected an object.`);
    }
  }

  assertNumber(config, 'temperature', { min: 0, max: 2 });
  assertNumber(config, 'maxTokens', { integer: true, min: 1 });
  assertNumber(config, 'timeoutMs', { integer: true, min: 1 });
  assertNumber(config.retry, 'maxAttempts', { integer: true, min: 1, max: 10 });
  assertNumber(config.retry, 'baseDelayMs', { integer: true, min: 0, max: 60000 });
  assertNumber(config.retry, 'maxDelayMs', { integer: true, min: 0, max: 300000 });
  assertNumber(config.metrics, 'maxEntries', { integer: true, min: 1, max: 10000 });
  if (config.retry.maxDelayMs < config.retry.baseDelayMs) {
    throw new Error('Invalid config "retry.maxDelayMs": must be >= retry.baseDelayMs.');
  }
  assertNumber(config, 'maxDiffChars', { integer: true, min: 1 });
  assertNumber(config, 'maxFileDiffChars', { integer: true, min: 1 });
  assertNumber(config, 'splitMaxDiffChars', { integer: true, min: 1 });
  assertNumber(config, 'splitMaxPlanFiles', { integer: true, min: 1 });
  assertNumber(config, 'diffContextLines', { integer: true, min: 0 });
  assertNumber(config.reasoning, 'maxTokens', { integer: true, min: 1 });
  assertNumber(config.reasoning, 'maxDisplayChars', { integer: true, min: 1 });

  return config;
}

// Whether a raw config (or any of its providers) carries a plaintext API key.
function configHasApiKey(cfg) {
  if (cfg && typeof cfg.apiKey === 'string' && cfg.apiKey) return true;
  const providers = cfg?.providers;
  if (providers && typeof providers === 'object') {
    return Object.values(providers).some((p) => p && typeof p.apiKey === 'string' && p.apiKey);
  }
  return false;
}

// The git repo root, or cwd when not inside a repo (config files are still
// looked up relative to cwd in that case). Shared by loadConfig and setup.
export function getProjectRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return process.cwd();
  }
}

export async function loadConfig(cliProvider = null, { resolveCredentials = true } = {}) {
  const projectRoot = getProjectRoot();
  let config = { ...DEFAULT_CONFIG };
  const loaded = [];

  const userPath = join(homedir(), '.aicommit.config.json');
  if (await fileExists(userPath)) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(userPath, 'utf-8'));
    } catch (err) {
      throw new Error(`Failed to parse user config ${userPath}: ${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Failed to parse user config ${userPath}: expected a JSON object.`);
    }
    config = mergeConfig(config, parsed);
    loaded.push('user');
    // Tighten loose permissions on config files that actually hold a key
    // (a hand-created or older 0644 file would otherwise expose it).
    if (configHasApiKey(parsed)) await chmod(userPath, 0o600).catch(() => {});
  }

  const projectPath = join(projectRoot, '.aicommit.config.json');
  if (projectPath !== userPath && (await fileExists(projectPath))) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(projectPath, 'utf-8'));
    } catch (err) {
      throw new Error(`Failed to parse project config ${projectPath}: ${err.message}`);
    }
    const { safe, ignored } = filterProjectConfig(parsed, config);
    config = mergeConfig(config, safe);
    loaded.push('project');
    if (ignored.length) {
      console.error(
        chalk.yellow(
          `  ⚠ Ignored unsafe settings from untrusted project config: ${ignored.join(', ')}`,
        ),
      );
      console.error(
        chalk.dim('    Put provider credentials and endpoints in ~/.aicommit.config.json.'),
      );
    }
  }

  const teamPolicy = await readTeamPolicy(projectRoot);
  let { config: resolvedConfig, providerName } = resolveProvider(config, cliProvider);

  // A repository-owned team policy is a strict, credential-free document.
  // Apply it after selecting the personal provider so provider-scoped user
  // preferences cannot change the committed policy on developer machines.
  if (teamPolicy) {
    resolvedConfig = mergeConfig(resolvedConfig, {
      language: teamPolicy.language,
      commitPolicy: teamPolicy.commitPolicy,
    });
    loaded.push('team policy');
  }

  validateConfig(resolvedConfig);
  const credential = resolveCredentials
    ? resolveCredential(resolvedConfig)
    : {
        apiKey: resolvedConfig.apiKey,
        source: 'not_resolved',
        sourceLabel: 'not resolved',
        warning: null,
      };
  if (resolveCredentials) resolvedConfig.apiKey = credential.apiKey;

  return {
    config: resolvedConfig,
    projectRoot,
    loaded,
    providerName,
    credentialSource: credential.source,
    credentialSourceLabel: credential.sourceLabel,
    credentialWarning: credential.warning || null,
  };
}
