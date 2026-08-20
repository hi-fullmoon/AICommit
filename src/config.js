import { readFile, chmod } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import chalk from 'chalk';

import { fileExists, deepMerge } from './utils.js';

export const DEFAULT_CONFIG = {
  apiUrl: 'https://api.openai.com/v1/chat/completions',
  apiKey: '',
  modelId: 'gpt-4o',
  temperature: 0.3,
  language: 'zh', // 'zh' = Chinese, 'en' = English
  maxTokens: 1024,
  // Per-request timeout in milliseconds — a hung endpoint aborts with a clear
  // error instead of leaving the spinner running forever.
  timeoutMs: 120000,
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
  // Compact rules + one few-shot example: explicit rules and a concrete
  // example steer models far more reliably than abstract prose, and the
  // prompt is sent on every call — every token here is paid per request.
  prompt: [
    'You are a git commit message generator. Write ONE commit message for the git diff the user provides.',
    '',
    '## Output contract (highest priority)',
    '',
    '- Output ONLY the commit message itself: no reasoning, no explanation, no quotes, no markdown code fences.',
    '- The first character of your reply must be the first letter of the type (e.g. "f" for feat).',
    '',
    '## Format',
    '',
    '<type>: <short subject>',
    '',
    '- <change point 1>',
    '- <change point 2>',
    '',
    '- Types: feat (new feature), fix (bug fix), chore (build/deps/config), refactor, style, docs, test, perf, ci, build.',
    '- The subject line is required (max 50 characters); after a blank line you may add bullet points starting with "- ". Omit them when the subject says it all.',
    '- If the diff contains several independent changes: pick the type and subject from the most important change, and list the rest as bullet points.',
    '- Never use empty filler wording like "updated the code" or "made many changes" that carries no information.',
    '',
    '## Example',
    '',
    'feat: set up system menu routes and page structure',
    '',
    '- add 19 page directories and base components across 7 modules',
    '- configure routes in config/routes.ts',
    '- add src/config/menu.ts menu config, wired into BasicLayout',
  ].join('\n'),
};

// Resolve the final flat config from a merged config that may contain a
// "providers" map: pick `cliProvider` → config.defaultProvider → first
// provider key, deep-merge that entry over the top-level values, then drop
// the providers/defaultProvider keys so downstream code sees a plain flat
// config.
function resolveProvider(config, cliProvider) {
  const providers = config.providers;

  if (cliProvider && !providers) {
    console.error(chalk.red(`  ✗ -p/--provider given ("${cliProvider}") but no "providers" defined in config.`));
    console.error(chalk.dim('  Define a "providers" map in ~/.aicommit.config.json or ./.aicommit.config.json'));
    process.exit(1);
  }

  if (!providers || typeof providers !== 'object' || Object.keys(providers).length === 0) {
    return { config, providerName: null };
  }

  const name = cliProvider || config.defaultProvider || Object.keys(providers)[0];

  if (!providers[name]) {
    console.error(chalk.red(`  ✗ Unknown provider: "${name}"`));
    console.error(chalk.dim(`  Available providers: ${Object.keys(providers).join(', ')}`));
    process.exit(1);
  }

  const resolved = deepMerge(config, providers[name]);
  delete resolved.providers;
  delete resolved.defaultProvider;
  return { config: resolved, providerName: name };
}

function assertString(config, key) {
  if (typeof config[key] !== 'string' || !config[key].trim()) {
    throw new Error(`Invalid config "${key}": expected a non-empty string.`);
  }
}

function assertUrl(config, key) {
  assertString(config, key);
  try {
    const u = new URL(config[key]);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
  } catch {
    throw new Error(`Invalid config "${key}": expected an http(s) URL.`);
  }
}

function assertNumber(config, key, { integer = false, min = -Infinity, max = Infinity } = {}) {
  const value = config[key];
  const ok = typeof value === 'number'
    && Number.isFinite(value)
    && (!integer || Number.isInteger(value))
    && value >= min
    && value <= max;
  if (!ok) {
    const kind = integer ? 'integer' : 'number';
    const range = Number.isFinite(max) ? ` between ${min} and ${max}` : ` >= ${min}`;
    throw new Error(`Invalid config "${key}": expected a ${kind}${range}.`);
  }
}

export function validateConfig(config) {
  assertUrl(config, 'apiUrl');
  assertString(config, 'modelId');
  assertString(config, 'prompt');

  if (typeof config.apiKey !== 'string') {
    throw new Error('Invalid config "apiKey": expected a string. Use "" for keyless local endpoints.');
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

  assertNumber(config, 'temperature', { min: 0, max: 2 });
  assertNumber(config, 'maxTokens', { integer: true, min: 1 });
  assertNumber(config, 'timeoutMs', { integer: true, min: 1 });
  assertNumber(config, 'maxDiffChars', { integer: true, min: 1 });
  assertNumber(config, 'maxFileDiffChars', { integer: true, min: 1 });
  assertNumber(config, 'splitMaxDiffChars', { integer: true, min: 1 });
  assertNumber(config, 'splitMaxPlanFiles', { integer: true, min: 1 });
  assertNumber(config, 'diffContextLines', { integer: true, min: 0 });

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
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return process.cwd();
  }
}

export async function loadConfig(cliProvider = null) {
  const projectRoot = getProjectRoot();

  const paths = [
    { p: join(homedir(), '.aicommit.config.json'),   label: 'user' },
    { p: join(projectRoot, '.aicommit.config.json'),  label: 'project' },
  ];

  let config = { ...DEFAULT_CONFIG };
  const loaded = [];

  for (const { p, label } of paths) {
    if (await fileExists(p)) {
      try {
        const raw    = await readFile(p, 'utf-8');
        const parsed = JSON.parse(raw);
        config = deepMerge(config, parsed);
        loaded.push(label);
        // Tighten loose permissions on config files that actually hold a key
        // (a hand-created or older 0644 file would otherwise expose it).
        if (configHasApiKey(parsed)) await chmod(p, 0o600).catch(() => {});
      } catch (err) {
        console.error(chalk.red(`  ⚠ Failed to parse ${p}: ${err.message}`));
      }
    }
  }

  const { config: resolvedConfig, providerName } = resolveProvider(config, cliProvider);

  return { config: validateConfig(resolvedConfig), projectRoot, loaded, providerName };
}
