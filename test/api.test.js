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

function stubSSE(events) {
  const calls = [];
  globalThis.fetch = async (_url, opts) => {
    calls.push(JSON.parse(opts.body));
    const body = events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
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
  const hits = sys.match(/Simplified Chinese/g) || [];
  assert.equal(hits.length, 1);
  assert.ok(sys.startsWith('generate a commit message'), 'custom prompt first');
});

test('user message repeats the language constraint after the diff', async () => {
  const calls = stubFetch([{ choices: [{ message: { content: 'feat: x' } }] }]);
  await generateCommitMessage(cfg({ language: 'en' }), diff);
  const user = calls[0].messages.find(m => m.role === 'user').content;
  assert.ok(user.endsWith('(Remember: the commit message must be in English.)'));
});

test('reasoning model: empty content + reasoning triggers a follow-up call', async () => {
  const calls = stubFetch([
    { choices: [{ message: { content: null, reasoning_content: 'think\nconclusion: fix: handle empty diff\n' } }] },
    { choices: [{ message: { content: 'fix: handle empty diff' } }] },
  ]);
  const { message, reasoning } = await generateCommitMessage(cfg(), diff);
  assert.equal(message, 'fix: handle empty diff');
  assert.match(reasoning, /conclusion: fix/);
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

test('usage aggregates Anthropic-style input/output token fields', async () => {
  stubFetch([
    { choices: [{ message: { content: '"feat: add x"' } }],
      usage: { input_tokens: 100, output_tokens: 10 } },
    { choices: [{ message: { content: 'feat: add x' } }],
      usage: { input_tokens: 20, output_tokens: 5 } },
  ]);
  const { message, usage } = await generateCommitMessage(cfg(), diff);
  assert.equal(message, 'feat: add x');
  assert.deepEqual(usage, { input_tokens: 120, output_tokens: 15 });
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

test('token-limited reasoning response is retried as a complete compact answer', async () => {
  const calls = stubFetch([
    {
      choices: [{
        finish_reason: 'length',
        message: {
          content: '[{"subject":"feat: add AI","body":"- add settings',
          reasoning_content: 'Group the AI files together and the UI files together.',
        },
      }],
    },
    {
      choices: [{
        finish_reason: 'stop',
        message: { content: '[{"subject":"feat: add AI","files":["ai.js"]}]' },
      }],
    },
  ]);

  const { text } = await getResponseText(
    cfg({
      apiUrl: 'https://api.minimaxi.com/v1/chat/completions',
      modelId: 'MiniMax-M3',
      reasoning: { mode: 'on', effort: 'medium', maxTokens: 4096 },
    }),
    [
      { role: 'system', content: 'Return a JSON array.' },
      { role: 'user', content: 'large diff that must not be sent again' },
    ],
    0.3,
    4096,
    'Output ONLY the JSON array split plan. Omit optional body fields.',
  );

  assert.equal(text, '[{"subject":"feat: add AI","files":["ai.js"]}]');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].max_tokens, 8192, 'recovery gets room for the complete answer');
  assert.deepEqual(calls[1].thinking, { type: 'disabled' }, 'recovery does not repeat reasoning');
  assert.ok(!calls[1].messages.some(m => m.content.includes('large diff')), 'reasoning replaces the original diff');
  assert.match(calls[1].messages.at(-1).content, /COMPLETE answer from the beginning/);
});

test('streaming preserves a length finish_reason and recovers the response', async () => {
  const calls = [];
  const responses = [
    [
      { choices: [{ delta: { content: '[{"subject":"fix: x"' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ],
    [
      { choices: [{ delta: { content: '[{"subject":"fix: x","files":["x.js"]}]' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ],
  ];
  let responseIndex = 0;
  globalThis.fetch = async (_url, opts) => {
    calls.push(JSON.parse(opts.body));
    const events = responses[Math.min(responseIndex++, responses.length - 1)];
    const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };

  const { text } = await getResponseText(
    cfg(),
    [{ role: 'user', content: 'plan these files' }],
    0.3,
    2048,
    'Output ONLY the complete JSON array.',
    { onReasoningDelta() {} },
  );

  assert.equal(text, '[{"subject":"fix: x","files":["x.js"]}]');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].max_tokens, 4096);
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

test('regenerate does not re-send the diff — it asks for a rewording of the previous message', async () => {
  const calls = stubFetch([{ choices: [{ message: { content: 'feat: rework login page' } }] }]);
  const { message } = await generateCommitMessage(cfg(), diff, 1, 'feat: add login page');
  assert.equal(message, 'feat: rework login page');
  const user = calls[0].messages.find(m => m.role === 'user').content;
  assert.ok(!user.includes('Here is the git diff'), 'diff not re-sent');
  assert.match(user, /feat: add login page/, 'previous message fed back');
  assert.match(user, /DIFFERENT commit message/);
  assert.match(user, /\(Remember: the commit message must be in English\.\)$/, 'language reminder kept');
});

test('regenerate without a previous message still sends the full diff', async () => {
  const calls = stubFetch([{ choices: [{ message: { content: 'feat: x' } }] }]);
  await generateCommitMessage(cfg(), diff, 1); // no previousMessage
  const user = calls[0].messages.find(m => m.role === 'user').content;
  assert.ok(user.includes('Here is the git diff'));
});

test('regenerateWithDiff opts back into re-sending the diff on regenerate', async () => {
  const calls = stubFetch([{ choices: [{ message: { content: 'feat: y' } }] }]);
  await generateCommitMessage(cfg({ regenerateWithDiff: true }), diff, 2, 'feat: add login page');
  const user = calls[0].messages.find(m => m.role === 'user').content;
  assert.ok(user.includes('Here is the git diff'), 'diff re-sent');
  assert.match(user, /Attempt #3: please produce a DIFFERENT commit message/, 'attempt hint kept');
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

test('checkConnection exposes reasoning returned by the provider', async () => {
  stubFetch([{
    choices: [{ message: { content: 'OK', reasoning_content: 'checked endpoint and model' } }],
  }]);
  const report = await checkConnection(cfg());
  assert.equal(report.reasoning, 'checked endpoint and model');
});

test('reasoning arrays and summary objects are normalized for terminal display', async () => {
  stubFetch([{
    choices: [{ message: {
      content: 'OK',
      reasoning_details: [{ text: 'step one' }, { summary: 'step two' }],
    } }],
  }]);
  const report = await checkConnection(cfg());
  assert.equal(report.reasoning, 'step one\nstep two');
});

test('reasoning mode consumes SSE deltas and streams normalized reasoning', async () => {
  const calls = stubSSE([
    { model: 'mock-stream', choices: [{ delta: { reasoning_content: 'step one\n' } }] },
    { choices: [{ delta: { reasoning_details: [{ text: 'step two\n' }] } }] },
    { choices: [{ delta: { content: 'feat: stream reasoning' } }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
    '[DONE]',
  ]);
  const deltas = [];
  const result = await generateCommitMessage(cfg({
    reasoning: {
      mode: 'on', effort: 'low', maxTokens: 4096,
      enabledBody: { enable_thinking: true },
    },
  }), diff, 0, '', { onReasoningDelta: chunk => deltas.push(chunk) });

  assert.equal(calls[0].stream, true);
  assert.equal(result.message, 'feat: stream reasoning');
  assert.equal(result.reasoning, 'step one\nstep two\n');
  assert.deepEqual(deltas, ['step one\n', 'step two\n']);
  assert.deepEqual(result.usage, { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 });
});

test('streaming rejects a clean EOF that has no completion marker', async () => {
  stubSSE([
    { model: 'mock-stream', choices: [{ delta: { content: 'feat: partial' } }] },
  ]);

  await assert.rejects(
    () => generateCommitMessage(
      cfg(), diff, 0, '', { onReasoningDelta() {} },
    ),
    /ended before the provider sent \[DONE\] or a finish_reason/,
  );
});

test('streaming accepts finish_reason when a compatible provider omits [DONE]', async () => {
  stubSSE([
    { model: 'mock-stream', choices: [{ delta: { content: 'feat: complete' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);

  const result = await generateCommitMessage(
    cfg(), diff, 0, '', { onReasoningDelta() {} },
  );
  assert.equal(result.message, 'feat: complete');
});

test('OpenAI streams request usage while preserving other stream options', async () => {
  const calls = stubSSE([
    { model: 'gpt-4o', choices: [{ delta: { content: 'feat: usage' } }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
    '[DONE]',
  ]);

  const result = await generateCommitMessage(cfg({
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    modelId: 'gpt-4o',
    reasoning: { mode: 'on', effort: 'low', maxTokens: 4096 },
    extraBody: { stream_options: { include_obfuscation: false, include_usage: false } },
  }), diff, 0, '', { onReasoningDelta() {} });

  assert.deepEqual(calls[0].stream_options, {
    include_obfuscation: false,
    include_usage: true,
  });
  assert.deepEqual(result.usage, { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
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

test('standard request body has no vendor thinking params', async () => {
  const calls = stubFetch([{ choices: [{ message: { content: 'feat: x' } }] }]);
  await generateCommitMessage(
    cfg({ apiUrl: 'https://api.openai.com/v1/chat/completions', modelId: 'gpt-4o' }), diff,
  );
  const body = calls[0];
  assert.equal(body.temperature, 0.3);
  assert.equal(body.max_tokens, 1024);
  assert.ok(!('enable_thinking' in body) && !('thinking' in body) && !('reasoning_split' in body));
});

test('OpenAI reasoning models get max_completion_tokens and no temperature', async () => {
  const calls = stubFetch([{ choices: [{ message: { content: 'feat: x' } }] }]);
  await generateCommitMessage(
    cfg({ apiUrl: 'https://api.openai.com/v1/chat/completions', modelId: 'gpt-5-mini' }), diff,
  );
  const body = calls[0];
  assert.equal(body.max_completion_tokens, 1024);
  assert.ok(!('max_tokens' in body) && !('temperature' in body));
});

test('default-on reasoning stays compatible with non-reasoning OpenAI models', async () => {
  const calls = stubFetch([{ choices: [{ message: { content: 'feat: x' } }] }]);
  await generateCommitMessage(cfg({
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    modelId: 'gpt-4o',
    reasoning: { mode: 'on', effort: 'low', maxTokens: 4096 },
  }), diff);
  assert.ok(!('reasoning_effort' in calls[0]));
  assert.equal(calls[0].max_tokens, 4096);
});

test('non-OpenAI endpoints also use the standard body by default', async () => {
  const calls = stubFetch([{ choices: [{ message: { content: 'feat: x' } }] }]);
  await generateCommitMessage(cfg(), diff);
  const body = calls[0];
  assert.ok(!('enable_thinking' in body) && !('thinking' in body) && !('reasoning_split' in body));
  assert.equal(body.max_tokens, 1024);
});

test('extraBody explicitly adds provider-specific request fields', async () => {
  const calls = stubFetch([{ choices: [{ message: { content: 'feat: x' } }] }]);
  await generateCommitMessage(cfg({
    extraBody: { enable_thinking: false, thinking: { type: 'disabled' }, reasoning_split: true },
  }), diff);
  const body = calls[0];
  assert.equal(body.enable_thinking, false);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.reasoning_split, true);
});

test('extraBody cannot replace the selected model or messages', async () => {
  const calls = stubFetch([{ choices: [{ message: { content: 'feat: x' } }] }]);
  await generateCommitMessage(cfg({
    extraBody: { model: 'injected-model', messages: [], seed: 7 },
  }), diff);
  assert.equal(calls[0].model, 'mock-model');
  assert.ok(calls[0].messages.length > 0);
  assert.equal(calls[0].seed, 7);
});

test('OpenAI reasoning CLI config maps to reasoning_effort and raises the output budget', async () => {
  const calls = stubFetch([{ choices: [{ message: { content: 'feat: x' } }] }]);
  await generateCommitMessage(cfg({
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    modelId: 'gpt-5-mini',
    reasoning: { mode: 'on', effort: 'low', maxTokens: 4096 },
  }), diff);
  assert.equal(calls[0].reasoning_effort, 'low');
  assert.equal(calls[0].max_completion_tokens, 4096);
});

test('OpenAI reasoning effort is validated against the model generation', async () => {
  let calls = stubFetch([{ choices: [{ message: { content: 'feat: x' } }] }]);
  await assert.rejects(
    () => generateCommitMessage(cfg({
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      modelId: 'gpt-5.1',
      reasoning: { mode: 'on', effort: 'max', maxTokens: 4096 },
    }), diff),
    /gpt-5\.1.*does not support reasoning effort "max"/,
  );
  assert.equal(calls.length, 0, 'invalid effort rejected before fetch');

  calls = stubFetch([{ choices: [{ message: { content: 'feat: x' } }] }]);
  await assert.rejects(
    () => generateCommitMessage(cfg({
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      modelId: 'o3',
      reasoning: { mode: 'off', effort: 'low', maxTokens: 4096 },
    }), diff),
    /o3.*does not support disabling reasoning/,
  );
  assert.equal(calls.length, 0, 'unsupported disable rejected before fetch');

  calls = stubFetch([{ choices: [{ message: { content: 'feat: x' } }] }]);
  await generateCommitMessage(cfg({
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    modelId: 'gpt-5.6-sol',
    reasoning: { mode: 'on', effort: 'max', maxTokens: 4096 },
  }), diff);
  assert.equal(calls[0].reasoning_effort, 'max');
});

test('OpenRouter reasoning uses the normalized reasoning object', async () => {
  const calls = stubFetch([{ choices: [{ message: { content: 'feat: x' } }] }]);
  await generateCommitMessage(cfg({
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    reasoning: { mode: 'on', effort: 'medium', maxTokens: 4096 },
  }), diff);
  assert.deepEqual(calls[0].reasoning, { effort: 'medium' });
  assert.equal(calls[0].max_tokens, 4096);
});

test('DeepSeek V4 enables native thinking and normalizes reasoning effort', async () => {
  const calls = stubFetch([{ choices: [{ message: { content: 'feat: x' } }] }]);
  await generateCommitMessage(cfg({
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    modelId: 'deepseek-v4-flash',
    reasoning: { mode: 'on', effort: 'medium', maxTokens: 4096 },
  }), diff);
  assert.deepEqual(calls[0].thinking, { type: 'enabled' });
  assert.equal(calls[0].reasoning_effort, 'high');
  assert.equal(calls[0].max_tokens, 4096);
  assert.ok(!('temperature' in calls[0]));
});

test('DeepSeek reasoning can be explicitly disabled', async () => {
  const calls = stubFetch([{ choices: [{ message: { content: 'feat: x' } }] }]);
  await generateCommitMessage(cfg({
    apiUrl: 'https://api.deepseek.com/chat/completions',
    modelId: 'deepseek-v4-pro',
    reasoning: { mode: 'off', effort: 'max', maxTokens: 4096 },
  }), diff);
  assert.deepEqual(calls[0].thinking, { type: 'disabled' });
  assert.ok(!('reasoning_effort' in calls[0]));
  assert.equal(calls[0].temperature, 0.3);
});

test('MiniMax reasoning removes the disabling switch and keeps reasoning split', async () => {
  const calls = stubFetch([{ choices: [{ message: { content: 'feat: x' } }] }]);
  await generateCommitMessage(cfg({
    apiUrl: 'https://api.minimaxi.com/v1/chat/completions',
    modelId: 'MiniMax-M3',
    extraBody: { thinking: { type: 'disabled' }, reasoning_split: true },
    reasoning: { mode: 'on', effort: 'low', maxTokens: 4096 },
  }), diff);
  assert.ok(!('thinking' in calls[0]));
  assert.equal(calls[0].reasoning_split, true);
});

test('custom endpoints stay standard by default and accept explicit enabledBody', async () => {
  const calls = stubFetch([{ choices: [{ message: { content: 'feat: x' } }] }]);
  await generateCommitMessage(cfg({
    reasoning: { mode: 'on', effort: 'low', maxTokens: 4096 },
  }), diff);
  assert.ok(!('enable_thinking' in calls[0]));

  await generateCommitMessage(cfg({
    reasoning: {
      mode: 'on', effort: 'low', maxTokens: 4096,
      enabledBody: { enable_thinking: true },
    },
  }), diff);
  assert.equal(calls[1].enable_thinking, true);
});
