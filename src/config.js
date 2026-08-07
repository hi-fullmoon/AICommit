import { readFile } from 'node:fs/promises';
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
  // Context lines around each diff hunk (git diff --unified=<n>). Fewer lines
  // means fewer tokens; commit messages rarely need git's default of 3.
  diffContextLines: 3,
  // Extra files to stub out of the diff like lock files, matched by basename
  // with "*" wildcards (e.g. ["*.min.js", "*.map", "*.snap"]). Generated
  // artifacts carry no commit intent but can be enormous.
  stripFiles: [],
  // Structured rules + few-shot examples: weaker models follow numbered rules
  // and mimic concrete examples far more reliably than abstract prose. Two
  // examples with different types (one scoped, one not) keep weak models from
  // copying a single example's type/scope onto every diff.
  prompt: [
    'You are a commit message generator. Write ONE conventional commit message for the git diff the user provides.',
    '',
    'Rules:',
    '1. The first line MUST be "<type>: <subject>" or "<type>(<scope>): <subject>", where <type> is one of: feat, fix, chore, docs, refactor, test, style, perf, ci, build.',
    '2. Subject: imperative mood ("add", not "added" or "adds"), no trailing period, max 72 chars.',
    '3. Add a body after a blank line only when the "what" or "why" is not obvious from the subject; most diffs need only the first line.',
    '4. Output ONLY the commit message — no explanation, no quotes, no markdown code fences. The first character of your reply must be the first letter of the type.',
    '5. The examples below only show the format — always pick the type, scope, and wording from the actual diff.',
    '',
    'Example diff:',
    '```diff',
    'diff --git a/src/auth.js b/src/auth.js',
    '+export async function login(user, pass) {',
    "+  return api.post('/login', { user, pass });",
    '+}',
    '```',
    'Example output:',
    'feat(auth): add login API call',
    '',
    'Example diff:',
    '```diff',
    'diff --git a/README.md b/README.md',
    '-## Instalation',
    '+## Installation',
    '```',
    'Example output:',
    'docs: fix typo in installation heading',
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

export async function loadConfig(cliProvider = null) {
  let projectRoot;
  try {
    projectRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    projectRoot = process.cwd();
  }

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
      } catch (err) {
        console.error(chalk.red(`  ⚠ Failed to parse ${p}: ${err.message}`));
      }
    }
  }

  const { config: resolvedConfig, providerName } = resolveProvider(config, cliProvider);

  return { config: resolvedConfig, projectRoot, loaded, providerName };
}
