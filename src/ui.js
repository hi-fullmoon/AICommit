import readline from 'node:readline';

import chalk from 'chalk';
import boxen from 'boxen';
import confirm from '@inquirer/confirm';
import select from '@inquirer/select';
import checkbox from '@inquirer/checkbox';
import editor from '@inquirer/editor';

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

export async function vimSelect(options) {
  return withVimKeys(select, options);
}

export async function vimCheckbox(options) {
  return withVimKeys(checkbox, options);
}

export async function confirmAction(message) {
  displayMessage(message);

  const action = await vimSelect({
    message: 'What would you like to do?',
    choices: [
      { name:  'Use this message',     value: 'use',        description: 'Commit with the suggested message' },
      { name:  'Regenerate',           value: 'regenerate', description: 'Ask AI to generate a different message' },
      { name:  'Edit message',         value: 'edit',       description: 'Modify the message before committing' },
      { name:  'Cancel',               value: 'cancel',     description: 'Abort the commit' },
    ],
  });

  return action;
}

export async function editMessage(message) {
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
