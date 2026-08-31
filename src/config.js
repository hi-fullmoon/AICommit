import { readFile, chmod } from 'node:fs/promises';
import { execSync } from 'node:child_process';

import chalk from 'chalk';

import { deepMerge, fileExists } from './utils.js';
import { ERROR_CATEGORIES, fail } from './errors.js';
import { resolveCredential } from './credentials.js';
import { DEFAULT_COMMIT_POLICY, mergeCommitPolicy, validateCommitPolicyConfig } from './policy.js';
import {
  DEFAULT_REPOSITORY_CONTEXT,
  filterProjectRepositoryContext,
  mergeRepositoryContext,
  validateRepositoryContextConfig,
} from './context.js';
import { readTeamPolicy } from './team-policy.js';
import {
  DEFAULT_REASONING_EFFORT,
  isProviderType,
  PROVIDER_TYPES,
  REASONING_EFFORTS,
} from './providers.js';
import { projectConfigPath, resolveConfigLocations, userConfigLocations } from './config-paths.js';

// Repository-owned config is untrusted input: a cloned repository must never
// be able to redirect requests while inheriting the API key from the user's
// global config. Project config may tune generation/display behaviour, but all
// connection and provider selection fields remain user-owned.
export const PROJECT_CONNECTION_KEYS = new Set([
  'schemaVersion',
  'apiUrl',
  'apiKey',
  'apiKeyEnv',
  'modelId',
  'models',
  'defaultModel',
  'providerType',
  'providers',
  'defaultProvider',
  'extraBody',
  'retry',
  'credentialHelper',
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
    effort: DEFAULT_REASONING_EFFORT,
    maxTokens: 4096,
    maxDisplayChars: 12000,
  },
  // Optional user-approved guidance appended to the structured policy.
  prompt: '',
};

export const CONFIG_SCHEMA_VERSION = 1;

const CONFIG_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOP_LEVEL_CONNECTION_KEYS = new Set([
  'apiUrl',
  'apiKey',
  'apiKeyEnv',
  'modelId',
  'providerType',
  'defaultModel',
  'models',
  'extraBody',
]);
const USER_CONFIG_KEYS = new Set([
  'schemaVersion',
  'defaultProvider',
  'providers',
  ...Object.keys(DEFAULT_CONFIG).filter((key) => !TOP_LEVEL_CONNECTION_KEYS.has(key)),
]);
const PROVIDER_CONFIG_KEYS = new Set([
  'providerType',
  'apiUrl',
  'apiKey',
  'apiKeyEnv',
  'credentialHelper',
  'retry',
  'defaultModel',
  'models',
]);
const MODEL_CONFIG_KEYS = new Set([
  'label',
  'modelId',
  'temperature',
  'maxTokens',
  'timeoutMs',
  'reasoning',
  'extraBody',
]);

const DEFAULT_PROVIDER_CATALOG = Object.freeze({
  defaultProvider: 'openai',
  providers: {
    openai: {
      providerType: 'openai',
      apiUrl: DEFAULT_CONFIG.apiUrl,
      defaultModel: 'default',
      models: {
        default: { modelId: DEFAULT_CONFIG.modelId },
      },
    },
  },
});

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

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function assertKnownKeys(value, allowed, path) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new Error(`Invalid config "${path}": unknown properties: ${unknown.join(', ')}.`);
  }
}

function assertConfigId(value, path) {
  if (typeof value !== 'string' || !CONFIG_ID_RE.test(value)) {
    throw new Error(
      `Invalid config "${path}": expected 1-64 letters, digits, dots, dashes, or underscores.`,
    );
  }
}

function providerRuntimeConfig(provider) {
  const { defaultModel: _defaultModel, models: _models, ...runtime } = provider;
  return runtime;
}

function modelRuntimeConfig(model) {
  const { label: _label, ...runtime } = model;
  return runtime;
}

export function validateUserConfig(value) {
  if (!object(value)) throw new Error('Invalid user config: expected a JSON object.');
  if (value.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `Invalid config "schemaVersion": expected ${CONFIG_SCHEMA_VERSION}. ` +
        'Run "aicommit setup" to create the current Provider/Model format.',
    );
  }
  assertKnownKeys(value, USER_CONFIG_KEYS, 'root');
  assertConfigId(value.defaultProvider, 'defaultProvider');
  if (!object(value.providers) || Object.keys(value.providers).length === 0) {
    throw new Error('Invalid config "providers": expected a non-empty object.');
  }
  if (!Object.hasOwn(value.providers, value.defaultProvider)) {
    throw new Error(
      `Invalid config "defaultProvider": unknown provider "${value.defaultProvider}".`,
    );
  }

  const globalConfig = { ...value };
  delete globalConfig.schemaVersion;
  delete globalConfig.defaultProvider;
  delete globalConfig.providers;
  const baseConfig = mergeConfig(DEFAULT_CONFIG, globalConfig);

  for (const [providerName, provider] of Object.entries(value.providers)) {
    assertConfigId(providerName, `providers.${providerName}`);
    if (!object(provider)) {
      throw new Error(`Invalid config "providers.${providerName}": expected an object.`);
    }
    assertKnownKeys(provider, PROVIDER_CONFIG_KEYS, `providers.${providerName}`);
    for (const required of ['providerType', 'apiUrl', 'defaultModel', 'models']) {
      if (!Object.hasOwn(provider, required)) {
        throw new Error(`Invalid config "providers.${providerName}": missing ${required}.`);
      }
    }
    assertConfigId(provider.defaultModel, `providers.${providerName}.defaultModel`);
    if (!object(provider.models) || Object.keys(provider.models).length === 0) {
      throw new Error(`Invalid config "providers.${providerName}.models": expected models.`);
    }
    if (!Object.hasOwn(provider.models, provider.defaultModel)) {
      throw new Error(
        `Invalid config "providers.${providerName}.defaultModel": unknown model ` +
          `"${provider.defaultModel}".`,
      );
    }

    const providerConfig = mergeConfig(baseConfig, providerRuntimeConfig(provider));
    for (const [modelName, model] of Object.entries(provider.models)) {
      assertConfigId(modelName, `providers.${providerName}.models.${modelName}`);
      if (!object(model)) {
        throw new Error(
          `Invalid config "providers.${providerName}.models.${modelName}": expected an object.`,
        );
      }
      assertKnownKeys(model, MODEL_CONFIG_KEYS, `providers.${providerName}.models.${modelName}`);
      if (!Object.hasOwn(model, 'modelId')) {
        throw new Error(
          `Invalid config "providers.${providerName}.models.${modelName}": missing modelId.`,
        );
      }
      if (
        Object.hasOwn(model, 'label') &&
        (typeof model.label !== 'string' || !model.label.trim() || model.label.length > 80)
      ) {
        throw new Error(
          `Invalid config "providers.${providerName}.models.${modelName}.label": ` +
            'expected a non-empty string of at most 80 characters.',
        );
      }
      validateConfig(mergeConfig(providerConfig, modelRuntimeConfig(model)));
    }
  }

  return value;
}

// Select a Provider and one of its named Model profiles, then flatten both
// layers so request and split code keep consuming one runtime
// config with a concrete modelId.
function resolveSelection(config, catalog, cliProvider, cliModel) {
  const providers = catalog.providers;
  const providerName = cliProvider || catalog.defaultProvider;
  const provider = providers[providerName];

  if (!provider) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      `Unknown provider: "${providerName}". Available providers: ${Object.keys(providers).join(', ')}`,
    );
  }
  const modelName = cliModel || provider.defaultModel;
  const model = provider.models[modelName];
  if (!model) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      `Unknown model: "${modelName}" for provider "${providerName}". ` +
        `Available models: ${Object.keys(provider.models).join(', ')}`,
    );
  }

  const providerConfig = mergeConfig(config, providerRuntimeConfig(provider));
  const resolvedConfig = mergeConfig(providerConfig, modelRuntimeConfig(model));
  return { config: resolvedConfig, providerName, modelName };
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
    (config.providerType !== '' && !isProviderType(config.providerType))
  ) {
    throw new Error(`Invalid config "providerType": expected ${PROVIDER_TYPES.join(', ')}, or "".`);
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
  if (!REASONING_EFFORTS.includes(config.reasoning.effort)) {
    throw new Error(`Invalid config "reasoning.effort": expected ${REASONING_EFFORTS.join(', ')}.`);
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

function warnLegacyConfig(kind, locations) {
  console.error(chalk.yellow(`  ⚠ Using legacy ${kind} config: ${locations.legacy}`));
  console.error(chalk.dim(`    Move it to ${locations.canonical}.`));
}

export async function loadConfig(
  cliProvider = null,
  { model: cliModel = null, resolveCredentials = true } = {},
) {
  const projectRoot = getProjectRoot();
  let config = { ...DEFAULT_CONFIG };
  let catalog = DEFAULT_PROVIDER_CATALOG;
  const loaded = [];

  const userLocations = await resolveConfigLocations(userConfigLocations());
  const userPath = userLocations.activePath;
  if (userPath) {
    if (userLocations.usingLegacy) warnLegacyConfig('user', userLocations);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(userPath, 'utf-8'));
    } catch (err) {
      throw new Error(`Failed to parse user config ${userPath}: ${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Failed to parse user config ${userPath}: expected a JSON object.`);
    }
    validateUserConfig(parsed);
    catalog = parsed;
    const globalConfig = { ...parsed };
    delete globalConfig.schemaVersion;
    delete globalConfig.defaultProvider;
    delete globalConfig.providers;
    config = mergeConfig(config, globalConfig);
    loaded.push('user');
    // Tighten loose permissions on config files that actually hold a key
    // (a hand-created or older 0644 file would otherwise expose it).
    if (configHasApiKey(parsed)) await chmod(userPath, 0o600).catch(() => {});
  }

  let {
    config: resolvedConfig,
    providerName,
    modelName,
  } = resolveSelection(config, catalog, cliProvider, cliModel);

  const projectPath = projectConfigPath(projectRoot);
  if (projectPath !== userPath && (await fileExists(projectPath))) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(projectPath, 'utf-8'));
    } catch (err) {
      throw new Error(`Failed to parse project config ${projectPath}: ${err.message}`);
    }
    const { safe, ignored } = filterProjectConfig(parsed, resolvedConfig);
    resolvedConfig = mergeConfig(resolvedConfig, safe);
    loaded.push('project');
    if (ignored.length) {
      console.error(
        chalk.yellow(
          `  ⚠ Ignored unsafe settings from untrusted project config: ${ignored.join(', ')}`,
        ),
      );
      console.error(
        chalk.dim('    Put provider credentials and endpoints in ~/.aicommit/config.json.'),
      );
    }
  }

  const teamPolicy = await readTeamPolicy(projectRoot);

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

  // These v2.0-era settings are intentionally ignored after the related
  // features were removed. Keeping old config files loadable makes the
  // product simplification a non-disruptive upgrade for normal users.
  delete resolvedConfig.metrics;
  delete resolvedConfig.extensions;

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
    modelName,
    credentialSource: credential.source,
    credentialSourceLabel: credential.sourceLabel,
    credentialWarning: credential.warning || null,
    teamPolicyPath: teamPolicy?.path || null,
  };
}
