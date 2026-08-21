import readline from 'node:readline';

import chalk from 'chalk';
import boxen from 'boxen';
import { createPrompt, useEffect, useKeypress, useRef, useState } from '@inquirer/core';
import confirm from '@inquirer/confirm';
import select from '@inquirer/select';
import checkbox from '@inquirer/checkbox';
import editor from '@inquirer/editor';
import wrapAnsi from 'wrap-ansi';

// Shared status → color/icon maps (A/M/D/R/C/T from git, '?' = untracked)
export const statusColor = {
  A: chalk.green,   // Added
  M: chalk.yellow,  // Modified
  D: chalk.red,     // Deleted
  R: chalk.cyan,    // Renamed
  C: chalk.magenta, // Copied
  T: chalk.blue,    // Type changed
  '?': chalk.green, // Untracked
};
export const statusIcon = { A: '+', M: '~', D: '-', R: '→', C: '©', T: 'Δ', '?': '+' };

export function highlightMessage(msg) {
  return msg.replace(
    /^(\w[\w-]*)([!:])(\s*)/,
    (_, type, punct, rest) =>
      chalk.cyan.bold(type) + chalk.yellow(punct) + rest,
  );
}

export function displayMessage(message) {
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

// Reasoning is provider-generated, untrusted terminal text. Strip escape and
// control sequences before display, then preserve both its beginning and end
// when applying the configured terminal-output cap.
export function formatReasoningForTerminal(reasoning, maxChars = 12000) {
  const cleaned = String(reasoning || '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;

  const marker = `\n\n... (reasoning truncated — ${cleaned.length} chars total) ...\n\n`;
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  const side = Math.max(0, Math.floor((maxChars - marker.length) / 2));
  return cleaned.slice(0, side) + marker + cleaned.slice(-side);
}

// Keep the default reasoning view compact, while measuring wrapped terminal
// lines instead of source lines. This means a long paragraph still occupies
// exactly two visible preview rows (including wide CJK characters).
export function getReasoningView(
  reasoning,
  {
    maxChars = 12000,
    expanded = false,
    columns = process.stdout.columns || 80,
    maxExpandedLines = Infinity,
    offset = 0,
  } = {},
) {
  const text = formatReasoningForTerminal(reasoning, maxChars);
  if (!text) {
    return { text: '', totalLines: 0, truncated: false, startLine: 0, endLine: 0 };
  }

  const contentWidth = Math.max(24, Math.min(columns - 6, 120));
  const lines = wrapAnsi(text, contentWidth, {
    hard: true,
    trim: false,
    wordWrap: true,
  }).split('\n');
  const previewLines = lines.filter((line) => line.trim());
  // During generation the useful context is at the tail, so the compact view
  // follows the newest two lines like other code-oriented CLIs.
  const pageSize = Number.isFinite(maxExpandedLines)
    ? Math.max(1, Math.floor(maxExpandedLines))
    : lines.length;
  const maxOffset = Math.max(0, lines.length - pageSize);
  const pageOffset = expanded
    ? Math.min(Math.max(0, Math.floor(offset)), maxOffset)
    : 0;
  const visibleLines = expanded
    ? lines.slice(pageOffset, pageOffset + pageSize)
    : previewLines.slice(-2);

  return {
    text: visibleLines.join('\n'),
    totalLines: lines.length,
    truncated: !expanded && previewLines.length > visibleLines.length,
    startLine: expanded ? pageOffset + 1 : Math.max(1, previewLines.length - visibleLines.length + 1),
    endLine: expanded ? pageOffset + visibleLines.length : previewLines.length,
  };
}

export function formatReasoningPanel(reasoning, options = {}) {
  const { expanded = false } = options;
  const view = getReasoningView(reasoning, options);

  if (!view.text) {
    return chalk.dim('  ◇ Thinking unavailable');
  }

  const page = expanded && view.totalLines > view.text.split('\n').length
    ? ` · ${view.startLine}-${view.endLine}/${view.totalLines} · PgUp/PgDn`
    : '';
  const state = expanded
    ? `Ctrl+O collapse${page}`
    : `Ctrl+O expand${view.truncated ? ` · ${view.totalLines} lines` : ''}`;
  const body = view.text.split('\n').map((line) => `  ${chalk.dim(line)}`).join('\n');
  return `${chalk.yellow('  ◇ Thinking')}  ${chalk.dim(`[${state}]`)}\n${body}`;
}

const CTRL_O_RELEASE_MS = 180;

function useCtrlOToggleGate() {
  const gate = useRef({ locked: false, timer: null });
  useEffect(() => () => clearTimeout(gate.current.timer), []);
  return gate;
}

// Terminal keypress events do not expose key-up. Treat a run of Ctrl+O repeat
// events as one hold: only the first toggles, and the gate re-opens shortly
// after key repeat stops.
function acceptCtrlOToggle(gate) {
  clearTimeout(gate.current.timer);
  gate.current.timer = setTimeout(() => {
    gate.current.locked = false;
    gate.current.timer = null;
  }, CTRL_O_RELEASE_MS);
  if (gate.current.locked) return false;
  gate.current.locked = true;
  return true;
}

function expandedLineCapacity(reservedRows) {
  return Math.max(4, (process.stdout.rows || 24) - reservedRows);
}

const reasoningStreamPrompt = createPrompt((config, done) => {
  const [text, setText] = useState(config.initialText || '');
  const [expanded, setExpanded] = useState(false);
  const [reasoningOffset, setReasoningOffset] = useState(0);
  const [status, setStatus] = useState('streaming');
  const ctrlOGate = useCtrlOToggleGate();
  const pageSize = expandedLineCapacity(4);
  const completeView = getReasoningView(text, { maxChars: config.maxChars, expanded: true });
  const maxOffset = Math.max(0, completeView.totalLines - pageSize);

  config.controller.update = setText;
  config.controller.finish = () => {
    setStatus('done');
    done(text);
  };

  useKeypress((key, rl) => {
    if (key.ctrl && key.name === 'o') {
      rl.clearLine(0);
      if (acceptCtrlOToggle(ctrlOGate)) {
        if (!expanded) setReasoningOffset(0);
        setExpanded(!expanded);
      }
      return;
    }
    if (expanded && key.name === 'pageup') {
      rl.clearLine(0);
      setReasoningOffset(Math.max(0, reasoningOffset - pageSize));
      return;
    }
    if (expanded && key.name === 'pagedown') {
      rl.clearLine(0);
      setReasoningOffset(Math.min(maxOffset, reasoningOffset + pageSize));
      return;
    }
    if (expanded && key.name === 'home') {
      rl.clearLine(0);
      setReasoningOffset(0);
      return;
    }
    if (expanded && key.name === 'end') {
      rl.clearLine(0);
      setReasoningOffset(maxOffset);
    }
  });

  if (status === 'done') return '';
  const panel = formatReasoningPanel(text, {
    maxChars: config.maxChars,
    expanded,
    maxExpandedLines: pageSize,
    offset: reasoningOffset,
  });
  return `${panel}\n${chalk.dim('  Thinking…  Ctrl+C cancel')}\x1B[?25l`;
});

// Start a redraw-safe live reasoning view. Updates are batched to one frame
// every ~32ms so token-sized SSE chunks do not cause hundreds of terminal
// redraws per second. The complete text remains available to the subsequent
// review prompt after this temporary view is cleared.
export function startReasoningStream(maxChars = 12000, initialText = '') {
  const controller = {};
  let accumulated = String(initialText || '');
  let timer = null;
  let stopped = false;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return {
      append(chunk) { accumulated += String(chunk || ''); },
      async stop() { stopped = true; return accumulated; },
    };
  }

  const prompt = reasoningStreamPrompt(
    { controller, maxChars, initialText: accumulated },
    { clearPromptOnDone: true },
  );

  const flush = () => {
    timer = null;
    controller.update?.(accumulated);
  };

  return {
    append(chunk) {
      if (stopped || !chunk) return;
      accumulated += String(chunk);
      if (!timer) timer = setTimeout(flush, 32);
    },
    async stop() {
      if (stopped) return accumulated;
      stopped = true;
      if (timer) clearTimeout(timer);
      flush();
      controller.finish?.();
      await prompt;
      return accumulated;
    },
  };
}

function normalizeSelectChoices(choices) {
  return choices.map((choice) => {
    if (typeof choice === 'string') {
      return { name: choice, short: choice, value: choice, disabled: false };
    }
    const name = choice.name ?? String(choice.value);
    return {
      ...choice,
      name,
      short: choice.short ?? name,
      disabled: choice.disabled ?? false,
    };
  });
}

function nextSelectableChoice(choices, active, offset, loop) {
  let next = active;
  for (let seen = 0; seen < choices.length; seen++) {
    const candidate = next + offset;
    if (!loop && (candidate < 0 || candidate >= choices.length)) return active;
    next = (candidate + choices.length) % choices.length;
    if (!choices[next].disabled) return next;
  }
  return active;
}

// A small select prompt dedicated to the reasoning review screen. Keeping the
// panel inside Inquirer's render cycle lets Ctrl+O redraw it without corrupting
// the choice cursor or leaving stale terminal rows behind.
const reasoningSelect = createPrompt((config, done) => {
  const choices = normalizeSelectChoices(config.choices);
  const first = choices.findIndex((choice) => !choice.disabled);
  if (first === -1) throw new Error('No selectable choices.');

  const [active, setActive] = useState(first);
  const [expanded, setExpanded] = useState(false);
  const [reasoningOffset, setReasoningOffset] = useState(0);
  const [status, setStatus] = useState('idle');
  const ctrlOGate = useCtrlOToggleGate();
  const selected = choices[active];
  const loop = config.loop !== false;
  const pageSize = expandedLineCapacity(choices.length + 8);
  const completeView = getReasoningView(config.reasoning.text, {
    maxChars: config.reasoning.maxChars,
    expanded: true,
    columns: config.reasoning.columns,
  });
  const maxOffset = Math.max(0, completeView.totalLines - pageSize);

  useKeypress((key, rl) => {
    if (key.ctrl && key.name === 'o') {
      rl.clearLine(0);
      if (acceptCtrlOToggle(ctrlOGate)) {
        if (!expanded) setReasoningOffset(0);
        setExpanded(!expanded);
      }
      return;
    }
    if (expanded && key.name === 'pageup') {
      rl.clearLine(0);
      setReasoningOffset(Math.max(0, reasoningOffset - pageSize));
      return;
    }
    if (expanded && key.name === 'pagedown') {
      rl.clearLine(0);
      setReasoningOffset(Math.min(maxOffset, reasoningOffset + pageSize));
      return;
    }
    if (expanded && key.name === 'home') {
      rl.clearLine(0);
      setReasoningOffset(0);
      return;
    }
    if (expanded && key.name === 'end') {
      rl.clearLine(0);
      setReasoningOffset(maxOffset);
      return;
    }
    if (key.name === 'up' || key.name === 'k') {
      rl.clearLine(0);
      setActive(nextSelectableChoice(choices, active, -1, loop));
      return;
    }
    if (key.name === 'down' || key.name === 'j') {
      rl.clearLine(0);
      setActive(nextSelectableChoice(choices, active, 1, loop));
      return;
    }
    if (key.name === 'return' || key.name === 'enter') {
      setStatus('done');
      done(selected.value);
    }
  });

  if (status === 'done') {
    return `${chalk.green('?')} ${config.message} ${chalk.cyan(selected.short)}`;
  }

  const panel = formatReasoningPanel(config.reasoning.text, {
    maxChars: config.reasoning.maxChars,
    expanded,
    columns: config.reasoning.columns,
    maxExpandedLines: pageSize,
    offset: reasoningOffset,
  });
  const rows = choices.map((choice, index) => {
    if (choice.disabled) return chalk.dim(`  - ${choice.name}`);
    return index === active
      ? chalk.cyan(`  ❯ ${choice.name}`)
      : `    ${choice.name}`;
  }).join('\n');
  const description = selected.description ? `\n  ${chalk.cyan(selected.description)}` : '';
  const pageHelp = expanded && maxOffset > 0 ? ' · PgUp/PgDn reasoning' : '';
  const help = chalk.dim(`  ↑↓/j k navigate · Enter select · Ctrl+O reasoning${pageHelp}`);

  return `${panel}\n\n${chalk.green('?')} ${config.message}\n${rows}${description}\n${help}\x1B[?25l`;
});

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

export async function vimSelect(options, reasoning) {
  if (reasoning) {
    return reasoningSelect({ ...options, reasoning });
  }
  return withVimKeys(select, options);
}

export async function vimCheckbox(options) {
  return withVimKeys(checkbox, options);
}

export async function confirmAction(message, reasoning) {
  displayMessage(message);

  const action = await vimSelect({
    message: 'What would you like to do?',
    choices: [
      { name:  'Use this message',     value: 'use',        description: 'Commit with the suggested message' },
      { name:  'Regenerate',           value: 'regenerate', description: 'Ask AI to generate a different message' },
      { name:  'Edit message',         value: 'edit',       description: 'Modify the message before committing' },
      { name:  'Cancel',               value: 'cancel',     description: 'Abort the commit' },
    ],
  }, reasoning);

  return action;
}

export async function editMessage(message) {
  // `postfix` is the temp file's extension (not a help text) — ".md" gives
  // the editor markdown highlighting; guidance belongs in `message`.
  const edited = await editor({
    message:   'Edit your commit message (save and close to continue, leave empty to cancel)',
    default:   message,
    postfix:   '.md',
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
