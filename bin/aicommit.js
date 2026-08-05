#!/usr/bin/env node

import { readFile, access, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import readline     from 'node:readline';

import chalk        from 'chalk';
import ora          from 'ora';
import boxen        from 'boxen';
import confirm      from '@inquirer/confirm';
import select       from '@inquirer/select';
import checkbox     from '@inquirer/checkbox';
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
    'Output ONLY the commit message, nothing else — do not wrap it in markdown code fences.',
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

// Strip markdown code fences the model sometimes wraps around the message
// (e.g. "```\nfix: ...\n```" or "```text\n...\n```"), plus stray backticks.
function cleanCommitMessage(msg) {
  const lines = msg.trim().split('\n');
  if (lines.length > 0 && /^\s*```[a-zA-Z]*\s*$/.test(lines[0])) lines.shift();
  if (lines.length > 0 && /^\s*```\s*$/.test(lines[lines.length - 1])) lines.pop();
  return lines.join('\n').trim();
}

function formatMs(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function maskApiKey(key) {
  if (!key) return '(not set)';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)} (${key.length} chars)`;
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
    -s, --split           Split changes into multiple logical commits
    --debug               Print debug info (parsed args, final config, etc.)

  ${chalk.bold('Examples:')}
    aicommit              Commit changes in current directory (Chinese)
    aicommit --lang=en    Generate English commit message
    aicommit --split      Group changes into several logical commits
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
  let debug = false;
  let split = false;

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

    if (arg === '--debug') {
      debug = true;
      continue;
    }

    if (arg === '-s' || arg === '--split') {
      split = true;
      continue;
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

  return { targetPath, cliLang, debug, split };
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

function getChangedFiles(isStaged) {
  const flag = isStaged ? '--staged' : '';
  try {
    const out = execSync(`git diff --name-status ${flag}`, {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    if (!out) return [];
    return out.split('\n').map(line => {
      // Format: "<status>\t<path>" or "<status>\t<old>\t<new>" for renames
      const parts = line.split('\t');
      const status = parts[0];
      const path   = parts.length === 3 ? `${parts[1]} → ${parts[2]}` : parts[1];
      return { status, path };
    });
  } catch { return []; }
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

// Shared status → color/icon maps (A/M/D/R/C/T from git, '?' = untracked)
const statusColor = {
  A: chalk.green,   // Added
  M: chalk.yellow,  // Modified
  D: chalk.red,     // Deleted
  R: chalk.cyan,    // Renamed
  C: chalk.magenta, // Copied
  T: chalk.blue,    // Type changed
  '?': chalk.green, // Untracked
};
const statusIcon = { A: '+', M: '~', D: '-', R: '→', C: '©', T: 'Δ', '?': '+' };

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

  return { message: cleanCommitMessage(message), elapsed, usage: data?.usage };
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

// Vim-friendly prompts: wraps @inquirer prompts with j/k → arrow key
// remapping. We intercept keypress events BEFORE @inquirer sees them and
// translate j→down, k→up by emitting synthetic arrow-key events.
// @inquirer ignores the original j/k characters, so only the arrow keys
// take effect.
async function withVimKeys(promptFn, options) {
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
    return await promptFn(options);
  } finally {
    process.stdin.removeListener('keypress', interceptor);
  }
}

async function vimSelect(options) {
  return withVimKeys(select, options);
}

async function vimCheckbox(options) {
  return withVimKeys(checkbox, options);
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
    // Pass the message as an argv item instead of a shell string — quoting it
    // for a shell breaks on Windows, where cmd.exe ignores single quotes.
    execFileSync('git', ['commit', '-m', message], { cwd: projectRoot, stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Split mode (--split): group changes into multiple logical commits
// ═══════════════════════════════════════════════════════════════════════════

// Cap the diff sent to the grouping call — the model only needs enough
// context to assign files to groups, not every line of a huge diff.
const SPLIT_MAX_DIFF_CHARS = 16000;

// All changes: staged, unstaged and untracked (porcelain -z avoids quoting
// issues with special characters in paths).
function getAllChangedFiles() {
  try {
    const out = execSync('git status --porcelain -z -uall', {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'],
    });
    if (!out) return [];
    const entries = out.split('\0').filter(Boolean);
    const files = [];
    for (let i = 0; i < entries.length; i++) {
      const entry  = entries[i];
      const status = entry.slice(0, 2);
      const path   = entry.slice(3);
      // Renames/copies carry a second NUL-separated path — skip it
      if (status.includes('R') || status.includes('C')) i++;
      files.push({ status: status.trim() || '?', path });
    }
    return files;
  } catch { return []; }
}

function hasHead(projectRoot) {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: projectRoot, stdio: ['pipe', 'pipe', 'ignore'],
    });
    return true;
  } catch { return false; }
}

// Diff of all tracked changes (staged + unstaged) against HEAD. Before the
// first commit there is no HEAD, so fall back to the staged diff.
function getSplitDiff(projectRoot, head) {
  const args = head ? ['diff', 'HEAD'] : ['diff', '--cached'];
  try {
    return execFileSync('git', args, {
      cwd: projectRoot, encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch { return ''; }
}

// Ask the model to partition the changed files into logical commits.
// Returns the raw response text; parsing happens in parsePlan/normalizePlan.
async function generateSplitPlan(config, files, diff) {
  const { apiUrl, apiKey, modelId, temperature, language, maxTokens } = config;
  const t0 = performance.now();

  const langLine = language === 'zh'
    ? 'Write each commit message in Chinese (Simplified Chinese).'
    : 'Write each commit message in English.';

  const truncated = diff.length > SPLIT_MAX_DIFF_CHARS;
  const diffPart  = truncated
    ? diff.slice(0, SPLIT_MAX_DIFF_CHARS) + '\n... (diff truncated)'
    : diff;

  const system = [
    'You are an expert at organizing git changes into small, atomic commits.',
    'Group the changed files into logical commits by feature or module.',
    'Rules:',
    '- Each group must represent ONE logical change and get a conventional commit message (feat, fix, chore, docs, refactor, test, style, perf, ci, build).',
    '- Every changed file must appear in EXACTLY one group; do not invent files.',
    '- Prefer a few coherent groups over many tiny ones; use a single group if the changes are one logical unit.',
    '- ' + langLine,
    '- Output ONLY a JSON array like [{"message":"feat: add login","files":["a.js"]}], no markdown fences, no explanation.',
  ].join('\n');

  const user =
    `Changed files:\n${files.map(f => `${f.status} ${f.path}`).join('\n')}` +
    `\n\nDiff:\n\`\`\`diff\n${diffPart}\n\`\`\``;

  const data = await callAPI(apiUrl, apiKey, modelId, [
    { role: 'system', content: system },
    { role: 'user',   content: user },
  ], temperature, Math.max(maxTokens, 2048));

  const raw = data?.choices?.[0]?.message?.content
    || data?.content?.[0]?.text
    || '';

  if (!raw.trim()) {
    throw new Error('API returned an empty split plan.');
  }

  return { raw, elapsed: performance.now() - t0, usage: data?.usage };
}

// Extract the JSON array from the model's response (tolerates code fences
// and surrounding prose).
function parsePlan(raw) {
  let text = raw.trim();
  const fence = text.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('[');
  const end   = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('no JSON array found in the response');
  }
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('response is not a JSON array');
  return parsed;
}

// Clean up the model's plan: drop unknown/duplicate files, drop empty
// groups, and sweep any file the model forgot into a final catch-all group.
function normalizePlan(groups, allFiles, language) {
  const known    = new Map(allFiles.map(f => [f.path, f]));
  const assigned = new Set();
  const result   = [];

  for (const g of groups) {
    if (!g || typeof g.message !== 'string' || !Array.isArray(g.files)) continue;
    const files = [];
    for (const p of g.files) {
      if (known.has(p) && !assigned.has(p)) {
        assigned.add(p);
        files.push(p);
      }
    }
    if (files.length) result.push({ message: cleanCommitMessage(g.message), files });
  }

  const leftover = allFiles.map(f => f.path).filter(p => !assigned.has(p));
  if (leftover.length) {
    result.push({
      message: language === 'zh' ? 'chore: 更新其余文件' : 'chore: update remaining files',
      files:   leftover,
    });
  }

  return result;
}

function displayPlan(groups, allFiles) {
  const byPath = new Map(allFiles.map(f => [f.path, f]));
  console.log('\n  ' + chalk.cyan.bold(`Split plan: ${groups.length} commit${groups.length > 1 ? 's' : ''}`));
  groups.forEach((g, i) => {
    console.log(`\n  ${chalk.bold(`${i + 1}.`)} ${highlightMessage(g.message)}`);
    for (const p of g.files) {
      const status = (byPath.get(p)?.status || '?').charAt(0);
      const c    = statusColor[status] || chalk.dim;
      const icon = statusIcon[status]  || status;
      console.log(`     ${c(icon)} ${c(p)}`);
    }
  });
  console.log('');
}

// Let the user edit the plan as JSON in their editor.
// Returns the normalized plan, or null to keep the current one.
async function editPlan(groups, allFiles, language) {
  const edited = await editor({
    message:   'Edit the split plan (JSON array of {message, files})',
    default:   JSON.stringify(groups, null, 2),
    postfix:   'Save and close to apply, or leave empty to keep the current plan.',
    waitForUseInput: false,
  });

  if (!edited.trim()) return null;

  try {
    return normalizePlan(JSON.parse(edited), allFiles, language);
  } catch (err) {
    console.log('\n  ' + chalk.red(`✗ Invalid plan JSON: ${err.message} — keeping the current plan.\n`));
    return null;
  }
}

function runGit(args, projectRoot, inherit = false) {
  execFileSync('git', args, { cwd: projectRoot, stdio: inherit ? 'inherit' : 'pipe' });
}

// Diff limited to one group's files, used when regenerating that group's
// message. Untracked files never show up in git diff, so when the diff is
// empty feed the model the file names plus a content preview instead.
function getGroupDiff(projectRoot, head, group, allFiles) {
  const args = head
    ? ['diff', 'HEAD', '--', ...group.files]
    : ['diff', '--cached', '--', ...group.files];
  try {
    const diff = execFileSync('git', args, {
      cwd: projectRoot, encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    }).trim();
    if (diff) return diff;
  } catch { /* fall through to the file-list preview */ }

  const byPath = new Map(allFiles.map(f => [f.path, f]));
  const parts  = [];
  for (const p of group.files) {
    const status = byPath.get(p)?.status || '?';
    parts.push(`${status} ${p}`);
    if (status === '??' || status === '?') {
      try {
        const content = readFileSync(join(projectRoot, p), 'utf-8');
        const preview = content.length > 2000
          ? content.slice(0, 2000) + '\n... (truncated)'
          : content;
        parts.push('```\n' + preview + '\n```');
      } catch { /* unreadable file — the name alone still helps */ }
    }
  }
  return 'Changed files (new files, no diff available):\n' + parts.join('\n');
}

// Stage everything (so untracked files are included), then commit the
// groups one by one: unstage all → add the group's files → commit.
// Note: if a file has both staged and unstaged changes, the whole file is
// committed in its group — file-level splitting cannot separate hunks.
function executeSplit(groups, projectRoot, head) {
  runGit(['add', '-A'], projectRoot);

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    console.log('  ' + chalk.dim(`[${i + 1}/${groups.length}] `) + highlightMessage(g.message));
    try {
      if (head) runGit(['reset', '-q'], projectRoot);
      else      runGit(['rm', '-r', '-q', '--cached', '.'], projectRoot);
      runGit(['add', '--', ...g.files], projectRoot);
      runGit(['commit', '-m', g.message], projectRoot, true);
    } catch {
      console.log('\n  ' + chalk.red(`✗ Commit ${i + 1}/${groups.length} failed.`));
      console.log(chalk.dim(`  ${i} commit(s) already made. Remaining groups:`));
      for (let j = i; j < groups.length; j++) {
        console.log(`    ${j + 1}. ${groups[j].message}`);
      }
      console.log(chalk.dim('  Resolve the issue and commit the rest manually.\n'));
      return false;
    }
  }
  return true;
}

// Returns true when the split flow ran to completion (or exited); false
// means "fall back to the normal single-commit flow".
async function splitFlow(config, projectRoot) {
  const allFiles = getAllChangedFiles();

  if (allFiles.length === 0) {
    console.log('\n  ' + chalk.yellow('✗ No changes to commit.'));
    console.log(chalk.dim('  Stage your changes with ') + chalk.bold('git add') + chalk.dim(' first.\n'));
    process.exit(1);
  }

  if (allFiles.length === 1) {
    console.log('\n  ' + chalk.dim('Only one changed file — falling back to single-commit mode.'));
    return false;
  }

  const branch = getBranch();
  const head   = hasHead(projectRoot);

  console.log('\n  ' + `✓ ${chalk.bold(allFiles.length)} files changed` +
    (branch ? chalk.dim(`  on ${branch}`) : '') + chalk.dim('  (split mode)'));
  for (const { status, path } of allFiles) {
    const c    = statusColor[status.charAt(0)] || chalk.dim;
    const icon = statusIcon[status.charAt(0)]  || status.charAt(0);
    console.log(`  ${c('  ' + icon)} ${c(path)}`);
  }

  const diff = getSplitDiff(projectRoot, head);

  const spinner = ora({
    text:  chalk.dim(`Calling ${chalk.bold(config.modelId)} to plan commits ...`),
    color: 'cyan',
  }).start();

  let raw;
  try {
    let elapsed, usage;
    ({ raw, elapsed, usage } = await generateSplitPlan(config, allFiles, diff));
    let done = `Plan generated in ${chalk.bold(formatMs(elapsed))}`;
    if (usage) done += chalk.dim(`  (tokens: ${usage.prompt_tokens}+${usage.completion_tokens})`);
    spinner.succeed(done);
  } catch (err) {
    spinner.fail(chalk.red('API call failed'));
    console.log(`\n  ${err.message.split('\n').join('\n  ')}\n`);
    process.exit(1);
  }

  let groups;
  try {
    groups = normalizePlan(parsePlan(raw), allFiles, config.language);
  } catch (err) {
    console.log('\n  ' + chalk.red(`✗ Failed to parse the AI's split plan: ${err.message}`));
    console.log(chalk.dim('  Raw response:\n    ' + raw.slice(0, 400).split('\n').join('\n    ') + '\n'));
    process.exit(1);
  }

  if (groups.length === 0) {
    console.log('\n  ' + chalk.red('✗ The AI returned an empty split plan.\n'));
    process.exit(1);
  }

  // Review / edit / regenerate loop
  let regenCounts = groups.map(() => 0);

  while (true) {
    displayPlan(groups, allFiles);

    const action = await vimSelect({
      message: 'Proceed with this split plan?',
      choices: [
        { name: 'Commit all groups',    value: 'commit',     description: `Create ${groups.length} commits as shown` },
        { name: 'Regenerate a message', value: 'regenerate', description: 'Ask AI for a different message for one group' },
        { name: 'Edit plan',            value: 'edit',       description: 'Modify the plan (JSON) in your editor' },
        { name: 'Cancel',               value: 'cancel',     description: 'Abort without committing' },
      ],
    });

    if (action === 'cancel') {
      console.log(chalk.dim('\n  Split cancelled.\n'));
      process.exit(0);
    }

    if (action === 'edit') {
      const edited = await editPlan(groups, allFiles, config.language);
      if (edited) {
        groups = edited;
        regenCounts = groups.map(() => 0);
      }
      continue; // show the (possibly updated) plan again
    }

    if (action === 'regenerate') {
      const picked = await vimCheckbox({
        message: 'Regenerate which commit messages? (space to select, enter to confirm)',
        choices: groups.map((g, i) => ({
          // checkbox rows are single-line — show the subject only
          name:  `${i + 1}. ${g.message.split('\n')[0]}`,
          value: i,
        })),
      });

      for (const idx of picked) {
        const groupDiff = getGroupDiff(projectRoot, head, groups[idx], allFiles);
        const rspinner = ora({
          text:  chalk.dim(`Regenerating message for group ${idx + 1} ...`),
          color: 'cyan',
        }).start();
        try {
          regenCounts[idx]++;
          const { message, elapsed } = await generateCommitMessage(config, groupDiff, regenCounts[idx]);
          rspinner.succeed(`Group ${idx + 1} regenerated in ${chalk.bold(formatMs(elapsed))}`);
          groups[idx] = { ...groups[idx], message };
        } catch (err) {
          regenCounts[idx]--;
          rspinner.fail(chalk.red(`Group ${idx + 1} regenerate failed`));
          console.log(`\n  ${err.message.split('\n').join('\n  ')}\n`);
        }
      }
      continue; // show the updated plan again
    }

    break; // commit
  }

  console.log('');
  const ok = executeSplit(groups, projectRoot, head);
  if (ok) {
    console.log('\n  ' + chalk.green.bold(`✓ Done! Created ${groups.length} commits.\n`));
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  // ── CLI arguments ───────────────────────────────────────────────────

  const { targetPath, cliLang, debug, split } = parseArgs();

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
  console.log('  ' + chalk.dim(`Working directory: ${process.cwd()}`));

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

  // ── Debug output ─────────────────────────────────────────────────────

  if (debug) {
    console.log('');
    console.log('  ' + chalk.magenta.bold('🐛 Debug info'));
    console.log('  ' + chalk.dim('─'.repeat(45)));
    console.log(chalk.dim(`  argv:         ${process.argv.slice(2).join(' ') || '(none)'}`));
    console.log(chalk.dim(`  targetPath:   ${targetPath || '(not set)'}`));
    console.log(chalk.dim(`  cwd:          ${process.cwd()}`));
    console.log(chalk.dim(`  projectRoot:  ${projectRoot}`));
    console.log(chalk.dim(`  config files: ${loaded.join(', ') || '(none — defaults only)'}`));
    console.log(chalk.dim(`  cliLang:      ${cliLang || '(not set)'}`));
    console.log(chalk.dim(`  split:        ${split}`));
    console.log(chalk.dim('  final config:'));
    for (const [key, value] of Object.entries(config)) {
      const display = key === 'apiKey'
        ? maskApiKey(value)
        : JSON.stringify(value);
      const truncated = display.length > 100 ? display.slice(0, 100) + '…' : display;
      console.log(chalk.dim(`    ${key}: ${truncated}`));
    }
  }

  // ── 2. Diff ─────────────────────────────────────────────────────────

  if (split) {
    const handled = await splitFlow(config, projectRoot);
    if (handled) return;
    // Only one changed file — continue with the normal single-commit flow.
  }

  const { diff, isStaged } = getStagedDiff();
  if (!diff) {
    console.log('\n  ' + chalk.yellow('✗ No changes to commit.'));
    console.log(chalk.dim('  Stage your changes with ') + chalk.bold('git add') + chalk.dim(' first.\n'));
    process.exit(1);
  }

  const stats     = getDiffStats(diff);
  const changedFiles = getChangedFiles(isStaged);
  const branch    = getBranch();
  const stageIcon = isStaged ? chalk.green('staged') : chalk.yellow('unstaged');
  const changeStr = chalk.green(`+${stats.additions}`) + '  ' + chalk.red(`-${stats.deletions}`);

  let statLine = chalk.dim('  ') + `✓ ${chalk.bold(stats.files)} files (${stageIcon})  ${changeStr}`;
  if (branch) statLine += chalk.dim(`  on ${branch}`);
  console.log(statLine);

  for (const { status, path } of changedFiles) {
    const c = statusColor[status.charAt(0)] || chalk.dim;
    const icon = statusIcon[status.charAt(0)] || status.charAt(0);
    console.log(`  ${c('  ' + icon)} ${c(path)}`);
  }

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
