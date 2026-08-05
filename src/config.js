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
  prompt: [
    'Generate a concise, conventional commit message for the following git diff.',
    'Follow the conventional commits format (e.g., feat:, fix:, chore:, docs:, refactor:, test:, style:, perf:, ci:, build:).',
    'The message should have a short subject line (max 72 chars), optionally followed by a blank line and a more detailed body if needed.',
    'Output ONLY the commit message, nothing else — do not wrap it in markdown code fences.',
  ].join(' '),
};

// Resolve the final flat config from a merged config that may contain a
// "providers" map: pick `cliModel` → config.default → first provider key,
// deep-merge that entry over the top-level values, then drop the
// providers/default keys so downstream code sees a plain flat config.
function resolveProvider(config, cliModel) {
  const providers = config.providers;

  if (cliModel && !providers) {
    console.error(chalk.red(`  ✗ -m/--model given ("${cliModel}") but no "providers" defined in config.`));
    console.error(chalk.dim('  Define a "providers" map in ~/.aicommit.config.json or ./.aicommit.config.json'));
    process.exit(1);
  }

  if (!providers || typeof providers !== 'object' || Object.keys(providers).length === 0) {
    return { config, providerName: null };
  }

  const name = cliModel || config.default || Object.keys(providers)[0];

  if (!providers[name]) {
    console.error(chalk.red(`  ✗ Unknown provider: "${name}"`));
    console.error(chalk.dim(`  Available providers: ${Object.keys(providers).join(', ')}`));
    process.exit(1);
  }

  const resolved = deepMerge(config, providers[name]);
  delete resolved.providers;
  delete resolved.default;
  return { config: resolved, providerName: name };
}

export async function loadConfig(cliModel = null) {
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

  const { config: resolvedConfig, providerName } = resolveProvider(config, cliModel);

  return { config: resolvedConfig, projectRoot, loaded, providerName };
}
