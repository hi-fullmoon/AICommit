#!/usr/bin/env node

import { readFile, access, stat } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import readline     from 'node:readline';

import chalk        from 'chalk';
import ora          from 'ora';
import boxen        from 'boxen';
import confirm      from '@inquirer/confirm';
import select       from '@inquirer/select';
import editor       from '@inquirer/editor';

// ═══════════════════════════════════════════════════════════════════════════
// Default configuration
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = {
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
    -l, --lang=<zh|en>    Commit message language (default: zh)

  ${chalk.bold('Examples:')}
    aicommit              Commit changes in current directory (Chinese)
    aicommit --lang=en    Generate English commit message
    aicommit /path/to    Commit changes in the specified directory
`);
}

function showVersion() {
  console.log(`aicommit v${VERSION}`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let targetPath = null;
  let cliLang = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      showHelp();
      process.exit(0);
    }

    if (arg === '-v' || arg === '--version') {
      showVersion();
      process.exit(0);
    }

    if (arg === '-l' || arg === '--lang') {
      cliLang = args[++i];
      if (!cliLang) {
        console.error(chalk.red(`  Missing value for ${arg}. Use ${arg}=<zh|en>`));
        console.error(chalk.dim('  Use ') + chalk.bold('aicommit --help') + chalk.dim(' for usage.'));
        process.exit(1);
      }
      continue;
    }

    if (arg.startsWith('--lang=')) {
      cliLang = arg.slice('--lang='.length);
      continue;
    }

    if (arg.startsWith('-l') && arg.length > 2) {
      cliLang = arg.slice(2);
      continue;
    }

    if (!arg.startsWith('-')) {
      targetPath = arg;
    } else {
      console.error(chalk.red(`  Unknown option: ${arg}`));
      console.error(chalk.dim('  Use ') + chalk.bold('aicommit --help') + chalk.dim(' for usage.'));
      process.exit(1);
    }
  }

  return { targetPath, cliLang };
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

async function callAPI(apiUrl, apiKey, modelId, messages, temperature, maxTokens) {
  const body = JSON.stringify({
    model: modelId,
    messages,
    temperature,
    max_tokens: maxTokens,
    enable_thinking: false,
  });

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errText.slice(0, 400)}`);
  }

  return response.json();
}

async function generateCommitMessage(config, diff, regenerateCount = 0) {
  const { apiUrl, apiKey, modelId, prompt, temperature, language, maxTokens } = config;
  const t0 = performance.now();

  // Build language directive — prepended AND appended so it takes priority
  // even when the user's custom prompt contains conflicting language instructions.
  const langHintPre = language === 'zh'
    ? 'IMPORTANT: You MUST write the commit message in Chinese (Simplified Chinese).\n\n'
    : 'IMPORTANT: You MUST write the commit message in English.\n\n';
  const langHintPost = language === 'zh'
    ? '\n\nIMPORTANT: The commit message MUST be written in Chinese (Simplified Chinese).'
    : '\n\nIMPORTANT: The commit message MUST be written in English.';

  // On regenerate, vary the prompt and temperature to get a different result
  const variationHint = regenerateCount > 0
    ? `\n(Attempt #${regenerateCount + 1}: please produce a DIFFERENT commit message than before.)`
    : '';
  const variedTemperature = Math.min(temperature + regenerateCount * 0.15, 1.2);

  const messages = [
    { role: 'system', content: langHintPre + prompt + langHintPost },
    { role: 'user',    content: `Here is the git diff:\n\n\`\`\`diff\n${diff}\n\`\`\`` + variationHint },
  ];

  let data = await callAPI(apiUrl, apiKey, modelId, messages, variedTemperature, maxTokens);
  let message = data?.choices?.[0]?.message?.content;
  const reasoning = data?.choices?.[0]?.message?.reasoning_content;

  // Fallback: try Anthropic-style response format (content[0].text)
  if (!message && message !== '') {
    message = data?.content?.[0]?.text;
  }

  // When content is empty but reasoning_content exists (common with DeepSeek
  // reasoning models), make a follow-up call using the reasoning as context
  // to extract the final commit message.
  if (!message && reasoning) {
    const followUpMessages = [
      ...messages,
      { role: 'assistant', content: reasoning },
      {
        role: 'user',
        content:
          'Based on your analysis above, output ONLY the final conventional commit message ' +
          '(e.g. feat:, fix:, chore:, docs:, refactor:, test:, style:, perf:, ci:, build:). ' +
          'Do not include any other text, explanation, or code fences.',
      },
    ];

    data = await callAPI(apiUrl, apiKey, modelId, followUpMessages, variedTemperature, maxTokens);
    message = data?.choices?.[0]?.message?.content;
  }

  // Last resort: extract a message from the reasoning content itself
  if (!message && reasoning) {
    // Try to find a conventional commit line in the reasoning
    const match = reasoning.match(/(?:^|\n)((?:feat|fix|chore|docs|refactor|test|style|perf|ci|build)[\w]*[!:]\s*.+?)(?:\n|$)/i);
    if (match) {
      message = match[1].trim();
    } else {
      // Take the last non-empty line of reasoning as a fallback
      const lines = reasoning.split('\n').filter(l => l.trim());
      message = lines[lines.length - 1]?.trim() || reasoning.slice(0, 200).trim();
    }
  }

  const elapsed = performance.now() - t0;

  if (!message) {
    const snippet = JSON.stringify(data, null, 2).slice(0, 600);
    throw new Error(
      !data?.choices?.[0]?.message?.content && data?.choices?.[0]?.message?.content === ''
        ? `API returned an empty commit message.\n  Hint: the model produced reasoning but returned empty content.\n  Try setting "temperature" to a higher value in your config.\n\nRaw response:\n${snippet}`
        : `Unexpected API response shape — got:\n\n${snippet}\n\n` +
          `Expected OpenAI format (choices[0].message.content) or ` +
          `Anthropic format (content[0].text).`,
    );
  }

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

// Vim-friendly select: wraps @inquirer/select with j/k → arrow key remapping.
// We intercept keypress events BEFORE @inquirer sees them and translate
// j→down, k→up by emitting synthetic arrow-key events.  @inquirer ignores
// the original j/k characters, so only the arrow keys take effect.
async function vimSelect(options) {
  // Ensure keypress events are enabled on stdin (idempotent)
  readline.emitKeypressEvents(process.stdin);

  let inTranslate = false; // guard against re-entering our own synthetic emits

  const interceptor = (_str, key) => {
    if (inTranslate || !key) return;
    if (key.name === 'j') {
      inTranslate = true;
      process.stdin.emit('keypress', undefined, {
        name: 'down', sequence: '\x1B\x5B\x42', ctrl: false, meta: false, shift: false,
      });
      inTranslate = false;
    } else if (key.name === 'k') {
      inTranslate = true;
      process.stdin.emit('keypress', undefined, {
        name: 'up', sequence: '\x1B\x5B\x41', ctrl: false, meta: false, shift: false,
      });
      inTranslate = false;
    }
  };

  // prependListener ensures we run BEFORE @inquirer's own keypress handler
  process.stdin.prependListener('keypress', interceptor);

  try {
    return await select(options);
  } finally {
    process.stdin.removeListener('keypress', interceptor);
  }
}

async function confirmAction(message) {
  displayMessage(message);

  const action = await vimSelect({
    message: 'What would you like to do?',
    choices: [
      { name:  'Use this message',     value: 'use',        description: 'Commit with the suggested message' },
      { name:  'Edit message',         value: 'edit',       description: 'Modify the message before committing' },
      { name:  'Regenerate',           value: 'regenerate', description: 'Ask AI to generate a different message' },
      { name:  'Cancel',               value: 'cancel',     description: 'Abort the commit' },
    ],
  });

  return action;
}

async function editMessage(message) {
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

  const { targetPath, cliLang } = parseArgs();

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

  // ── CLI language override ────────────────────────────────────────────

  if (cliLang) {
    if (cliLang !== 'zh' && cliLang !== 'en') {
      console.log('\n  ' + chalk.red(`✗ Invalid language: "${cliLang}". Use "zh" or "en".\n`));
      process.exit(1);
    }
    config.language = cliLang;
    console.log('  ' + chalk.green('✓') + chalk.dim(` Language set to: ${cliLang === 'zh' ? '中文' : 'English'} (via CLI)`));
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

  // ── 3. AI call + confirm (with regenerate loop) ────────────────────

  let message, elapsed, usage;
  let regenerateCount = 0;

  while (true) {
    const spinner = ora({
      text:  chalk.dim(`Calling ${chalk.bold(config.modelId)} ...`),
      color: 'cyan',
    }).start();

    try {
      ({ message, elapsed, usage } = await generateCommitMessage(config, diff, regenerateCount));
      let done = `Generated in ${chalk.bold(formatMs(elapsed))}`;
      if (usage) {
        const tk = `${chalk.dim('tokens:')} ${usage.prompt_tokens}+${usage.completion_tokens}`;
        done += chalk.dim(`  (${tk})`);
      }
      spinner.succeed(done);
    } catch (err) {
      spinner.fail(chalk.red('API call failed'));
      console.log(`\n  ${err.message.split('\n').join('\n  ')}\n`);
      process.exit(1);
    }

    if (!message) {
      console.log('\n  ' + chalk.red('✗ Empty response from AI.\n'));
      process.exit(1);
    }

    // ── 4. User action ─────────────────────────────────────────────────

    const action = await confirmAction(message);

    if (action === 'use') {
      break; // proceed to commit
    }

    if (action === 'edit') {
      const edited = await editMessage(message);
      if (edited) {
        message = edited;
        break; // proceed to commit with edited message
      }
      // User cancelled during edit — exit
      console.log(chalk.dim('\n  Commit cancelled.\n'));
      process.exit(0);
    }

    if (action === 'regenerate') {
      regenerateCount++;
      console.log(chalk.dim(`\n  ↻ Regenerating (attempt #${regenerateCount + 1})...`));
      continue;
    }

    // action === 'cancel'
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

  const success = gitCommit(message, projectRoot);

  if (success) {
    console.log('\n  ' + chalk.green.bold('✓ Done!\n'));
  } else {
    console.log(chalk.dim('\n  You can manually commit with:'));
    console.log('  ' + chalk.dim('$ ') + chalk.green(`git commit -m '${message.replace(/'/g, "'\\''")}'`));
    console.log('');
  }
}

main().catch((err) => {
  console.error('\n  ' + chalk.red(`✗ ${err.message}\n`));
  process.exit(1);
});
