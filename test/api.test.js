import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { generateCommitMessage, checkConnection, getResponseText } from '../src/api.js';

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

// Stub global fetch with a queue of response bodies (each can be an object
// to JSON-stringify, or a raw string). Records every request body.
function stubFetch(bodies) {
  const calls = [];
  let i = 0;
  globalThis.fetch = async (_url, opts) => {
    calls.push(JSON.parse(opts.body));
    const body = bodies[Math.min(i, bodies.length - 1)];
    i++;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  };
  return calls;
}

const cfg = (extra = {}) => ({
  apiUrl: 'https://example.test/v1/chat/completions',
  apiKey: 'sk-test',
  modelId: 'mock-model',
  maxTokens: 1024,
  temperature: 0.3,
  language: 'en',
  prompt: 'generate a commit message',
  ...extra,
});
const diff = '--- a/x\n+++ b/x\n+foo';

test('reasoning model: empty content + reasoning triggers a follow-up call', async () => {
  const calls = stubFetch([
    { choices: [{ message: { content: null, reasoning_content: 'think\nconclusion: fix: handle empty diff\n' } }] },
    { choices: [{ message: { content: 'fix: handle empty diff' } }] },
  ]);
  const { message } = await generateCommitMessage(cfg(), diff);
  assert.equal(message, 'fix: handle empty diff');
  assert.equal(calls.length, 2); // follow-up was actually made
});

test('usage aggregates across the reasoning follow-up call', async () => {
  stubFetch([
    { choices: [{ message: { content: null, reasoning_content: 'think\nfix: x\n' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
    { choices: [{ message: { content: 'fix: x' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]);
  const { message, usage } = await generateCommitMessage(cfg(), diff);
  assert.equal(message, 'fix: x');
  assert.deepEqual(usage, { prompt_tokens: 110, completion_tokens: 55, total_tokens: 165 });
});

test('usage is reported from a single call when no follow-up is needed', async () => {
  stubFetch([
    { choices: [{ message: { content: 'refactor: simplify' } }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
  ]);
  const { usage } = await generateCommitMessage(cfg(), diff);
  assert.deepEqual(usage, { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 });
});

test('usage is null when the provider reports no token counts', async () => {
  stubFetch([
    { choices: [{ message: { content: 'chore: no usage' } }], usage: {} },
  ]);
  const { usage } = await generateCommitMessage(cfg(), diff);
  assert.equal(usage, null);
});

test('long reasoning trace is truncated to its tail for the follow-up', async () => {
  const calls = stubFetch([
    { choices: [{ message: { content: null, reasoning_content: 'A'.repeat(20000) + '\nfeat: add x\n' } }] },
    { choices: [{ message: { content: 'feat: add x' } }] },
  ]);
  await generateCommitMessage(cfg(), diff);
  const assistant = calls[1].messages.find(m => m.role === 'assistant');
  assert.ok(assistant.content.length <= 8001, 'truncated to tail');
  assert.ok(assistant.content.startsWith('…'), 'marks the cut');
  assert.ok(assistant.content.includes('feat: add x'), 'conclusion preserved');
});

test('last resort: extracts a mid-line conventional prefix from reasoning', async () => {
  stubFetch([
    { choices: [{ message: { content: null, reasoning: 'Hmm let me think.\nActually the final answer: docs: update README\nDone.' } }] },
    { choices: [{ message: { content: null } }] }, // follow-up also empty
  ]);
  const { message } = await generateCommitMessage(cfg(), diff);
  assert.equal(message, 'docs: update README');
});

test('whitespace-only content still triggers the reasoning follow-up', async () => {
  const calls = stubFetch([
    { choices: [{ message: { content: '\n   ', reasoning_details: [{ type: 'thinking', text: 'so: chore: bump deps' }] } }] },
    { choices: [{ message: { content: 'chore: bump deps' } }] },
  ]);
  const { message } = await generateCommitMessage(cfg(), diff);
  assert.equal(message, 'chore: bump deps');
  assert.equal(calls.length, 2);
});

test('getResponseText powers the split path: custom follow-up prompt, reasoning handled', async () => {
  const calls = stubFetch([
    { choices: [{ message: { content: null, reasoning: 'planning…\n[' } }] },
    { choices: [{ message: { content: '[{"message":"feat: add a","files":["a.js"]}]' } }] },
  ]);
  const { text } = await getResponseText(
    cfg(), [{ role: 'user', content: 'plan' }], 0.3, 2048,
    'output ONLY the JSON array split plan as requested',
  );
  assert.equal(text, '[{"message":"feat: add a","files":["a.js"]}]');
  assert.equal(calls.length, 2);
  const lastUser = calls[1].messages.at(-1);
  assert.equal(lastUser.role, 'user');
  assert.match(lastUser.content, /JSON array split plan/);
});

test('Anthropic-format response (content[0].text) is used without a follow-up', async () => {
  const calls = stubFetch([
    { content: [{ type: 'text', text: 'refactor: simplify' }] },
  ]);
  const { message } = await generateCommitMessage(cfg(), diff);
  assert.equal(message, 'refactor: simplify');
  assert.equal(calls.length, 1);
});

test('empty response throws a helpful error mentioning maxTokens', async () => {
  stubFetch([{ choices: [{ message: { content: null } }] }]);
  await assert.rejects(() => generateCommitMessage(cfg(), diff), /maxTokens/);
});

test('checkConnection extracts array-of-parts content and echoed model', async () => {
  stubFetch([
    { model: 'mock-echo', choices: [{ message: { content: [{ type: 'text', text: 'OK' }] } }] },
  ]);
  const report = await checkConnection(cfg());
  assert.equal(report.content, 'OK');
  assert.equal(report.model, 'mock-echo');
});

test('checkConnection surfaces HTTP errors', async () => {
  globalThis.fetch = async () => new Response('bad key', { status: 401 });
  await assert.rejects(() => checkConnection(cfg()), /HTTP 401/);
});
