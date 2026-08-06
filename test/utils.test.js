import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deepMerge, cleanCommitMessage, formatUsage, formatMs, maskApiKey, indentError,
} from '../src/utils.js';

test('deepMerge merges nested objects and replaces scalars/arrays', () => {
  const a = { x: 1, nested: { a: 1, b: 2 }, arr: [1] };
  const b = { x: 2, nested: { b: 3 }, arr: [2] };
  const r = deepMerge(a, b);
  assert.equal(r.x, 2);
  assert.deepEqual(r.nested, { a: 1, b: 3 });
  assert.deepEqual(r.arr, [2]); // arrays are replaced, not merged
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

test('formatUsage joins prompt and completion token counts', () => {
  assert.equal(formatUsage({ prompt_tokens: 5, completion_tokens: 2 }), '5+2');
});

test('formatMs renders milliseconds and seconds', () => {
  assert.equal(formatMs(500), '500ms');
  assert.equal(formatMs(1500), '1.5s');
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
