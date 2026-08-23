import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deepMerge, cleanCommitMessage, formatUsage, formatMs, maskApiKey, indentError,
  sanitizeTerminalText, stringifyConfigRedacted, isValidCommitMessage,
} from '../src/utils.js';

test('deepMerge merges nested objects, replaces scalars, concatenates arrays', () => {
  const a = { x: 1, nested: { a: 1, b: 2 }, arr: [1] };
  const b = { x: 2, nested: { b: 3 }, arr: [2, 1] };
  const r = deepMerge(a, b);
  assert.equal(r.x, 2);
  assert.deepEqual(r.nested, { a: 1, b: 3 });
  assert.deepEqual(r.arr, [1, 2]); // arrays merge (deduped), not replaced
});

test('deepMerge does not mutate the inputs', () => {
  const a = { nested: { a: 1 } };
  const b = { nested: { b: 2 } };
  deepMerge(a, b);
  assert.deepEqual(a, { nested: { a: 1 } });
});

test('cleanCommitMessage strips code fences and <think> blocks', () => {
  assert.equal(cleanCommitMessage('```\nfeat: add x\n```'), 'feat: add x');
  assert.equal(cleanCommitMessage('```text\nfix: a\n```'), 'fix: a');
  assert.equal(cleanCommitMessage('fix: a\n<think>…</think>'), 'fix: a');
  assert.equal(cleanCommitMessage('  docs: trim\n'), 'docs: trim');
});

test('cleanCommitMessage strips fences sharing a line with the message', () => {
  assert.equal(cleanCommitMessage('``` feat: add x'), 'feat: add x');
  assert.equal(cleanCommitMessage('``` feat: add x ```'), 'feat: add x');
  assert.equal(cleanCommitMessage('```\nfeat: add x\n- body line\n```'), 'feat: add x\n- body line');
  assert.equal(cleanCommitMessage('```text feat: add x'), 'feat: add x');
});

test('formatUsage always uses k/M units (k is the smallest)', () => {
  assert.equal(formatUsage({ prompt_tokens: 6800, completion_tokens: 900, total_tokens: 7700 }), '6.8k in + 0.9k out (total 7.7k)');
  assert.equal(formatUsage({ prompt_tokens: 500, completion_tokens: 200 }), '0.5k in + 0.2k out (total 0.7k)');
  assert.equal(formatUsage({ prompt_tokens: 1200000, completion_tokens: 500 }), '1.2M in + 0.5k out (total 1.2M)');
});

test('formatUsage total is the sum of the displayed parts, not the raw total', () => {
  // The provider's raw total (1950) would round to "2k" on its own, but the
  // displayed parts (1.6k + 0.3k) must add up to the shown total (1.9k).
  assert.equal(formatUsage({ prompt_tokens: 1600, completion_tokens: 300, total_tokens: 1950 }), '1.6k in + 0.3k out (total 1.9k)');
});

test('formatUsage accepts Anthropic-style input/output token fields', () => {
  assert.equal(formatUsage({ input_tokens: 6800, output_tokens: 900 }), '6.8k in + 0.9k out (total 7.7k)');
});

test('formatUsage handles total-only and empty usage objects', () => {
  assert.equal(formatUsage({ total_tokens: 7000 }), '7k');
  assert.equal(formatUsage({ total_tokens: 1000000 }), '1M');
  assert.equal(formatUsage({ total_tokens: 50 }), '0.05k');
  assert.equal(formatUsage({}), '');
});

test('formatMs renders milliseconds and seconds', () => {
  assert.equal(formatMs(500), '500ms');
  assert.equal(formatMs(1500), '1.5s');
});

test('formatMs rounds sub-second floats (performance.now() is not an integer)', () => {
  assert.equal(formatMs(452.090916), '452ms');
  assert.equal(formatMs(2.5), '3ms');
});

test('maskApiKey masks short keys and summarizes long ones', () => {
  assert.equal(maskApiKey(''), '(not set)');
  assert.equal(maskApiKey('short'), '****');
  assert.equal(maskApiKey('sk-abcdefghijkl'), 'sk-a…ijkl (15 chars)');
});

test('indentError indents every line of a multi-line error', () => {
  const err = new Error('line one\nline two');
  assert.equal(indentError(err), 'line one\n  line two');
});

test('deepMerge ignores prototype-pollution keys from JSON config', () => {
  const payload = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"safe":2}');
  const result = deepMerge({}, payload);
  assert.equal(result.safe, 2);
  assert.equal(result.polluted, undefined);
  assert.equal({}.polluted, undefined);
});

test('terminal text sanitizer removes ANSI, OSC, carriage returns, and controls', () => {
  const unsafe = '\u001b[2Jhello\rforged\u001b]52;c;YQ==\u0007\u0000';
  assert.equal(sanitizeTerminalText(unsafe), 'hello\nforged');
  assert.equal(cleanCommitMessage('fix: safe\u001b[2J subject'), 'fix: safe subject');
});

test('commit validation and recursive config redaction are strict', () => {
  assert.equal(isValidCommitMessage('feat(core): add safety checks'), true);
  assert.equal(isValidCommitMessage('updated files'), false);
  const rendered = stringifyConfigRedacted({
    extraBody: { authorization: 'Bearer secret-value', nested: { password: 'hunter22!' } },
  });
  assert.doesNotMatch(rendered, /secret-value|hunter22/);
});
