#!/usr/bin/env node

import { readFile, access, stat } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';

import chalk        from 'chalk';
import ora          from 'ora';
import boxen        from 'boxen';
import confirm      from '@inquirer/confirm';
import editor       from '@inquirer/editor';

// ═══════════════════════════════════════════════════════════════════════════
// Default configuration
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = {
  apiUrl: 'https://api.openai.com/v1/chat/completions',
  apiKey: '',
  modelId: 'gpt-4o',
  prompt: [
    'Generate a concise, conventional commit message for the following git diff.',
    'Follow the conventional commits format (e.g., feat:, fix:, chore:, docs:, refactor:, test:, style:, perf:, ci:, build:).',
    'The message should have a short subject line (max 72 chars), optionally followed by a blank line and a more detailed body if needed.',
    'Output ONLY the commit message, nothing else.',
  ].join(' '),
};

// ═══════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

function deepMerge(a, b) {
  const result = { ...a };
  for (const key of Object.keys(b)) {
    if (
      b[key] && typeof b[key] === 'object' && !Array.isArray(b[key]) &&
      a[key] && typeof a[key] === 'object' && !Array.isArray(a[key])
    ) {
      result[key] = deepMerge(a[key], b[key]);
    } else {
      result[key] = b[key];
    }
  }
  return result;
}

function formatMs(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI argument parsing
// ═══════════════════════════════════════════════════════════════════════════

const _require = createRequire(import.meta.url);
const { version: VERSION } = _require('../package.json');

function showHelp() {
  console.log(`
  ${chalk.cyan.bold('aicommit')} — AI-powered git commit message generator

  ${chalk.bold('Usage:')}
    ${chalk.dim('$')} aicommit [path] [options]

  ${chalk.bold('Arguments:')}
    path                  Target directory (default: current directory)

  ${chalk.bold('Options:')}
    -h, --help            Show this help message
    -v, --version         Show version number

  ${chalk.bold('Examples:')}
    aicommit              Commit changes in current directory
    aicommit .            Commit changes in current directory
    aicommit /path/to    Commit changes in the specified directory
`);
}

function showVersion() {
  console.log(`aicommit v${VERSION}`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let targetPath = null;

  for (const arg of args) {
    switch (arg) {
      case '-h':
      case '--help':
        showHelp();
        process.exit(0);
      case '-v':
      case '--version':
        showVersion();
        process.exit(0);
      default:
        if (!arg.startsWith('-')) {
          targetPath = arg;
        } else {
          console.error(chalk.red(`  Unknown option: ${arg}`));
          console.error(chalk.dim('  Use ') + chalk.bold('aicommit --help') + chalk.dim(' for usage.'));
          process.exit(1);
        }
    }
  }

  return targetPath;
}

// ═══════════════════════════════════════════════════════════════════════════
// Config loading
// ═══════════════════════════════════════════════════════════════════════════

async function loadConfig() {
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

  return { config, projectRoot, loaded };
}

// ═══════════════════════════════════════════════════════════════════════════
// Git helpers
// ═══════════════════════════════════════════════════════════════════════════

function getStagedDiff() {
  let diff;
  try {
    diff = execSync('git diff --staged', {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch { diff = ''; }

  const isStaged = diff.trim().length > 0;

  if (!isStaged) {
    try {
      diff = execSync('git diff', {
        encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch { diff = ''; }
  }

  return { diff: diff.trim(), isStaged };
}

function getDiffStats(diff) {
  if (!diff) return { files: 0, additions: 0, deletions: 0 };
  const lines = diff.split('\n');
  let files = 0, additions = 0, deletions = 0;
  for (const line of lines) {
    if      (line.startsWith('diff --git'))           files++;
    else if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { files, additions, deletions };
}

function getBranch() {
  try {
    return execSync('git branch --show-current', {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// AI API call
// ═══════════════════════════════════════════════════════════════════════════

async function generateCommitMessage(config, diff) {
  const { apiUrl, apiKey, modelId, prompt } = config;

  const body = JSON.stringify({
    model: modelId,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user',    content: `Here is the git diff:\n\n\`\`\`diff\n${diff}\n\`\`\`` },
    ],
    temperature: 0.3,
    max_tokens: 500,
  });

  const t0 = performance.now();
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body,
  });
  const elapsed = performance.now() - t0;

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errText.slice(0, 400)}`);
  }

  const data    = await response.json();
  const message = data?.choices?.[0]?.message?.content;
  if (!message) throw new Error('Unexpected API response shape');

  return { message: message.trim(), elapsed, usage: data?.usage };
}

// ═══════════════════════════════════════════════════════════════════════════
// Commit message display + confirmation
// ═══════════════════════════════════════════════════════════════════════════

function highlightMessage(msg) {
  return msg.replace(
    /^(\w[\w-]*)([!:])(\s*)/,
    (_, type, punct, rest) =>
      chalk.cyan.bold(type) + chalk.yellow(punct) + rest,
  );
}

function displayMessage(message) {
  const colored = message.split('\n').map(highlightMessage).join('\n');
  console.log(boxen(colored, {
    title:      'Suggested commit message',
    titleAlignment: 'center',
    padding:    { top: 1, right: 2, bottom: 1, left: 2 },
    margin:     { top: 1, left: 2 },
    borderColor: 'cyan',
    borderStyle: 'round',
  }));
}

async function confirmAndEdit(message) {
  displayMessage(message);

  const action = await confirm({
    message:  'Use this message?',
    default:  true,
    theme:    { prefix: { idle: chalk.dim('?'), done: chalk.green('?') } },
  });

  if (action) return message;

  // Edit flow: first ask whether to edit or cancel
  const wantEdit = await confirm({
    message: 'Edit the message?',
    default: true,
    theme:   { prefix: { idle: chalk.dim('?'), done: chalk.yellow('?') } },
  });

  if (!wantEdit) return null;

  const edited = await editor({
    message:   'Edit your commit message',
    default:   message,
    postfix:   'Save and close the editor to continue, or leave empty to cancel.',
    waitForUseInput: false,
  });

  if (!edited.trim()) return null;

  displayMessage(edited.trim());
  const reconfirm = await confirm({
    message: 'Commit with this edited message?',
    default: true,
    theme:   { prefix: { idle: chalk.dim('?'), done: chalk.green('?') } },
  });

  return reconfirm ? edited.trim() : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Git stage + commit
// ═══════════════════════════════════════════════════════════════════════════

function gitAdd(projectRoot) {
  execSync('git add -A', { cwd: projectRoot, stdio: 'pipe' });
}

function gitCommit(message, projectRoot) {
  try {
    const escaped = message.replace(/'/g, "'\\''");
    execSync(`git commit -m '${escaped}'`, { cwd: projectRoot, stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  // ── CLI arguments ───────────────────────────────────────────────────

  const targetPath = parseArgs();

  if (targetPath) {
    const resolved = resolve(targetPath);
    try {
      await stat(resolved);
      process.chdir(resolved);
    } catch {
      console.error(chalk.red(`  ✗ Error: '${targetPath}' is not a valid directory`));
      process.exit(1);
    }
  }

  // ── Banner ──────────────────────────────────────────────────────────

  console.log('');
  console.log('  ' + chalk.cyan.bold('⚡ aicommit ') + chalk.dim('AI-powered commit message generator'));
  console.log('  ' + chalk.dim('─'.repeat(45)));

  // ── 1. Config ───────────────────────────────────────────────────────

  const { config, projectRoot, loaded } = await loadConfig();

  if (loaded.length === 0) {
    console.log(chalk.dim('\n  No config files found — using defaults.'));
    console.log(chalk.dim('  Create ~/.aicommit.config.json to configure.'));
  } else {
    const labels = loaded.map(l => chalk.bold(l)).join(', ');
    console.log('\n  ' + chalk.green('✓') + chalk.dim(` Config loaded from: ${labels}`));
  }

  if (!config.apiKey) {
    console.log('\n  ' + chalk.red('✗ No API key configured.'));
    console.log(chalk.dim('  Set "apiKey" in ~/.aicommit.config.json or ./.aicommit.config.json\n'));
    process.exit(1);
  }

  // ── 2. Diff ─────────────────────────────────────────────────────────

  const { diff, isStaged } = getStagedDiff();
  if (!diff) {
    console.log('\n  ' + chalk.yellow('✗ No changes to commit.'));
    console.log(chalk.dim('  Stage your changes with ') + chalk.bold('git add') + chalk.dim(' first.\n'));
    process.exit(1);
  }

  const stats     = getDiffStats(diff);
  const branch    = getBranch();
  const stageIcon = isStaged ? chalk.green('staged') : chalk.yellow('unstaged');
  const changeStr = chalk.green(`+${stats.additions}`) + '  ' + chalk.red(`-${stats.deletions}`);

  let statLine = chalk.dim('  ') + `✓ ${chalk.bold(stats.files)} files (${stageIcon})  ${changeStr}`;
  if (branch) statLine += chalk.dim(`  on ${branch}`);
  console.log(statLine);

  // ── 3. AI call ──────────────────────────────────────────────────────

  const spinner = ora({
    text:  chalk.dim(`Calling ${chalk.bold(config.modelId)} ...`),
    color: 'cyan',
  }).start();

  let message, elapsed, usage;
  try {
    ({ message, elapsed, usage } = await generateCommitMessage(config, diff));
    let done = `Generated in ${chalk.bold(formatMs(elapsed))}`;
    if (usage) {
      const tk = `${chalk.dim('tokens:')} ${usage.prompt_tokens}+${usage.completion_tokens}`;
      done += chalk.dim(`  (${tk})`);
    }
    spinner.succeed(done);
  } catch (err) {
    spinner.fail(chalk.red('API call failed'));
    console.log(chalk.dim(`  ${err.message}\n`));
    process.exit(1);
  }

  if (!message) {
    console.log('\n  ' + chalk.red('✗ Empty response from AI.\n'));
    process.exit(1);
  }

  // ── 4. Confirm & commit ────────────────────────────────────────────

  const finalMessage = await confirmAndEdit(message);
  if (!finalMessage) {
    console.log(chalk.dim('\n  Commit cancelled.\n'));
    process.exit(0);
  }

  // ── 5. Auto-stage (if unstaged) & commit ────────────────────────────

  console.log('');

  if (!isStaged) {
    process.stdout.write(chalk.dim('  → Auto-staging changes... '));
    try {
      gitAdd(projectRoot);
      console.log(chalk.green('✓'));
    } catch {
      console.log(chalk.yellow('⚠'));
    }
  }

  const success = gitCommit(finalMessage, projectRoot);

  if (success) {
    console.log('\n  ' + chalk.green.bold('✓ Done!\n'));
  } else {
    console.log(chalk.dim('\n  You can manually commit with:'));
    console.log('  ' + chalk.dim('$ ') + chalk.green(`git commit -m '${finalMessage.replace(/'/g, "'\\''")}'`));
    console.log('');
  }
}

main().catch((err) => {
  console.error('\n  ' + chalk.red(`✗ ${err.message}\n`));
  process.exit(1);
});
