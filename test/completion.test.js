import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { generateCompletion } from '../src/completion.js';

test('completion generators cover stable commands and shell-specific registration', () => {
  for (const shell of ['bash', 'zsh', 'fish']) {
    const script = generateCompletion(shell);
    for (const command of ['config', 'policy', 'completion', 'split', 'doctor']) {
      assert.match(script, new RegExp(`\\b${command}\\b`), `${shell} omits ${command}`);
    }
    const longOptionPrefix = shell === 'fish' ? '-l ' : '--';
    for (const option of ['provider', 'model', 'output']) {
      const renderedOption = `${longOptionPrefix}${option}`;
      assert.match(script, new RegExp(renderedOption), `${shell} omits ${renderedOption}`);
    }
    const rangeOption = `${longOptionPrefix}range`;
    assert.match(script, new RegExp(rangeOption), `${shell} omits ${rangeOption}`);
    for (const action of ['run', 'resume', 'abort']) {
      assert.match(script, new RegExp(action), `${shell} omits ${action}`);
    }
    assert.doesNotMatch(script, /\bmetrics\b|\bstats\b|\bpreset\b|--split-hunks|--check|--split=/);
    assert.doesNotMatch(script, /apiKey|credential|secret/i);
  }
  assert.match(generateCompletion('bash'), /complete -F _aicommit aicommit/);
  assert.match(generateCompletion('zsh'), /^#compdef aicommit/m);
  assert.match(generateCompletion('fish'), /complete -c aicommit/);
  assert.throws(() => generateCompletion('powershell'), /Unsupported shell/);
});

test(
  'generated Bash completion passes the shell parser',
  { skip: process.platform === 'win32' },
  () => {
    execFileSync('bash', ['-n'], { input: generateCompletion('bash') });
  },
);
