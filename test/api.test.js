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

test('system prompt carries the language directive exactly once, appended after the prompt', async () => {
  const calls = stubFetch([{ choices: [{ message: { content: 'feat: x' } }] }]);
  await generateCommitMessage(cfg({ language: 'zh' }), diff);
  const sys = calls[0].messages.find(m => m.role === 'system').content;
  const hits = sys.match(/MUST be written in Chinese/g) || [];
  assert.equal(hits.length, 1);
  assert.ok(sys.startsWith('generate a commit message'), 'custom prompt first');
});

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

test('reasoning follow-up does not re-send the original diff', async () => {
  const calls = stubFetch([
    { choices: [{ message: { content: null, reasoning_content: 'analyzing…\nfix: x\n' } }] },
    { choices: [{ message: { content: 'fix: x' } }] },
  ]);
  await generateCommitMessage(cfg(), diff);
  const followUp = calls[1].messages;
  assert.ok(followUp.some(m => m.role === 'system'), 'system prompt kept for constraints');
  assert.equal(followUp.find(m => m.role === 'assistant').content, 'analyzing…\nfix: x\n');
  assert.ok(!followUp.some(m => m.content.includes('Here is the git diff')), 'diff not re-sent');
  assert.equal(followUp.at(-1).role, 'user');
  assert.match(followUp.at(-1).content, /output ONLY the final conventional commit message/);
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

test('non-conventional reply triggers a corrective retry without re-sending the diff', async () => {
  const calls = stubFetch([
    { choices: [{ message: { content: 'Updated the login page styling.' } }] },
    { choices: [{ message: { content: 'style: update login page styling' } }] },
  ]);
  const { message } = await generateCommitMessage(cfg(), diff);
  assert.equal(message, 'style: update login page styling');
  assert.equal(calls.length, 2, 'one corrective retry was made');
  const retry = calls[1].messages;
  assert.equal(retry[0].role, 'system', 'system prompt kept for language/format constraints');
  assert.match(retry.at(-1).content, /Updated the login page styling\./, 'bad reply fed back');
  assert.ok(!retry.some(m => m.content.includes('Here is the git diff')), 'diff not re-sent');
});

test('corrective retry usage aggregates with the first call', async () => {
  stubFetch([
    { choices: [{ message: { content: '"feat: add x"' } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
    { choices: [{ message: { content: 'feat: add x' } }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
  ]);
  const { message, usage } = await generateCommitMessage(cfg(), diff);
  assert.equal(message, 'feat: add x');
  assert.deepEqual(usage, { prompt_tokens: 120, completion_tokens: 15, total_tokens: 135 });
});

test('empty corrective retry keeps the original reply', async () => {
  const calls = stubFetch([
    { choices: [{ message: { content: 'Updated the login page styling.' } }] },
    { choices: [{ message: { content: null } }] },
  ]);
  const { message } = await generateCommitMessage(cfg(), diff);
  assert.equal(message, 'Updated the login page styling.');
  assert.equal(calls.length, 2);
});

test('valid conventional reply makes no corrective retry', async () => {
  const calls = stubFetch([
    { choices: [{ message: { content: 'fix(api): handle empty diff' } }] },
  ]);
  const { message } = await generateCommitMessage(cfg(), diff);
  assert.equal(message, 'fix(api): handle empty diff');
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

test('request timeouts are wrapped with a helpful message', async () => {
  globalThis.fetch = async () => {
    const err = new Error('The operation timed out.');
    err.name = 'TimeoutError';
    throw err;
  };
  await assert.rejects(() => checkConnection(cfg({ timeoutMs: 5000 })), /timed out after 5s/);
});
