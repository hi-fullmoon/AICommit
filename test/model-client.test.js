import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { requestGeneration } from '../src/model-client.js';
import { nodeSupported } from '../src/runtime.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const config = {
  apiUrl: 'https://proxy.example.test/tenant/models/chat?version=1',
  providerType: 'custom',
  modelId: 'unlisted-model',
  timeoutMs: 1000,
  retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
};
const request = {
  messages: [
    { role: 'system', content: 'Generate commits.' },
    { role: 'user', content: 'diff' },
  ],
  maxTokens: 256,
  temperature: 0.2,
};
const event = (value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const sse = (...events) =>
  new Response(events.map(event).join(''), { headers: { 'Content-Type': 'text/event-stream' } });

test('Pi request pins the complete proxy URL and uses only resolved credentials', async () => {
  const authorizations = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, config.apiUrl);
    assert.equal(init.redirect, 'error');
    authorizations.push(init.headers.get('authorization'));
    const payload = JSON.parse(init.body);
    assert.equal(payload.model, 'unlisted-model');
    assert.deepEqual(payload.messages, request.messages);
    return sse(chunk({ content: 'fix: route correctly' }, 'stop'), '[DONE]');
  };
  const keyless = await requestGeneration(config, request);
  await requestGeneration({ ...config, apiKey: 'explicit-test-key' }, request);
  assert.deepEqual(authorizations, [null, 'Bearer explicit-test-key']);
  assert.equal(keyless.piMessage.api, 'openai-completions');
  assert.equal(keyless.content, 'fix: route correctly');
  assert.equal(keyless.usage, null, 'unreported usage is not reported as zero');
});

test('Pi parses split UTF-8 SSE frames and cached token usage without double counting', async () => {
  const bytes = Buffer.from(
    [
      chunk({ reasoning_content: '检查变更' }),
      { model: 'served-model', ...chunk({ content: 'fix: 修复缓存' }, 'stop') },
      {
        choices: [],
        usage: {
          prompt_tokens: 30,
          completion_tokens: 10,
          total_tokens: 40,
          prompt_tokens_details: { cached_tokens: 20 },
          completion_tokens_details: { reasoning_tokens: 7 },
        },
      },
      '[DONE]',
    ]
      .map(event)
      .join(''),
  );
  globalThis.fetch = async () =>
    new Response(
      new globalThis.ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7));
          controller.close();
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  const deltas = [];
  const result = await requestGeneration(config, {
    ...request,
    stream: { onReasoningDelta: (text) => deltas.push(text) },
  });
  assert.equal(result.content, 'fix: 修复缓存');
  assert.equal(result.model, 'served-model');
  assert.deepEqual(deltas, ['检查变更']);
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 10, totalTokens: 40 });
  assert.equal(result.piMessage.usage.cacheRead, 20);
});

test('Pi textual reasoning metadata is displayed, encrypted metadata stays opaque', async () => {
  globalThis.fetch = async () =>
    sse(
      chunk({
        reasoning_details: [
          { type: 'reasoning.text', text: 'inspected diff' },
          { type: 'reasoning.encrypted', data: 'opaque-secret' },
        ],
      }),
      chunk({ content: 'feat: support metadata' }, 'stop'),
      '[DONE]',
    );
  const deltas = [];
  const result = await requestGeneration(config, {
    ...request,
    stream: { onReasoningDelta: (text) => deltas.push(text) },
  });
  assert.equal(result.reasoning, 'inspected diff');
  assert.deepEqual(deltas, ['inspected diff']);
});

test('accepted SSE interruption is not replayed by either Pi or the app', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    let sent = false;
    return new Response(
      new globalThis.ReadableStream({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(Buffer.from(event(chunk({ content: 'partial' }))));
          } else controller.error(new TypeError('socket terminated during response'));
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  };
  await assert.rejects(
    requestGeneration(config, request),
    (err) => err.category === 'network' && /socket/.test(err.message),
  );
  assert.equal(calls, 1);
});

test('Pi rejects DONE without a finish reason and never returns its partial content', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return sse(chunk({ content: 'partial' }), '[DONE]');
  };
  await assert.rejects(
    requestGeneration(config, request),
    (err) => err.category === 'response_format',
  );
  assert.equal(calls, 1);
});

test('callback errors abort the SDK request without retrying or leaving its signal alive', async () => {
  let signal;
  globalThis.fetch = async (_url, init) => {
    signal = init.signal;
    return sse(chunk({ reasoning_content: 'analysis' }), chunk({ content: 'answer' }, 'stop'));
  };
  await assert.rejects(
    requestGeneration(config, {
      ...request,
      stream: {
        onReasoningDelta() {
          throw new Error('UI closed');
        },
      },
    }),
    /UI closed/,
  );
  assert.equal(signal.aborted, true);
});

test('explicit non-streaming compatibility requests still use Pi result normalization', async () => {
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(init.body).stream, false);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'fix: support JSON' } }] }),
    );
  };
  const result = await requestGeneration({ ...config, extraBody: { stream: false } }, request);
  assert.equal(result.piMessage.content[0].text, 'fix: support JSON');
});

test('Ollama generate bridge uses prompt/system and retains options and thinking', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/generate');
    assert.equal(init.headers.get('authorization'), null);
    const payload = JSON.parse(init.body);
    assert.equal(payload.system, 'Generate commits.');
    assert.equal(payload.prompt, 'user: diff');
    assert.equal(payload.messages, undefined);
    assert.equal(payload.stream, false);
    assert.equal(payload.think, true);
    assert.deepEqual(payload.options, { temperature: 0.2, num_predict: 256, num_ctx: 8192 });
    return new Response(
      JSON.stringify({
        model: 'qwen3:8b',
        response: 'fix: local generation',
        thinking: 'local analysis',
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 10,
        eval_count: 5,
      }),
    );
  };
  const result = await requestGeneration(
    {
      ...config,
      apiUrl: 'http://127.0.0.1:11434/api/generate',
      providerType: 'ollama',
      modelId: 'qwen3:8b',
      reasoning: { mode: 'on' },
      extraBody: { options: { num_ctx: 8192 } },
    },
    request,
  );
  assert.equal(result.content, 'fix: local generation');
  assert.equal(result.reasoning, 'local analysis');
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
});

test('Node runtime guard matches Pi minimum including the minor boundary', () => {
  for (const version of ['18.20.8', '20.19.0', '22.18.0'])
    assert.equal(nodeSupported(version), false);
  for (const version of ['22.19.0', '22.20.0', '24.0.0'])
    assert.equal(nodeSupported(version), true);
});

test('Pi catalog distinguishes non-reasoning OpenRouter models from reasoning models', async () => {
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    assert.equal(payload.reasoning, undefined);
    return sse(chunk({ content: 'fix: respect model capabilities' }, 'stop'));
  };
  const result = await requestGeneration(
    {
      ...config,
      providerType: 'openrouter',
      modelId: 'openai/gpt-4o-mini',
      reasoning: { mode: 'on', effort: 'high' },
    },
    request,
  );
  assert.equal(result.capabilities.reasoning, 'model-dependent');
});

test('content filtering in a successful HTTP stream is a provider failure without replay', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return sse(chunk({ content: 'partial' }, 'content_filter'));
  };
  await assert.rejects(requestGeneration(config, request), (err) => err.category === 'provider');
  assert.equal(calls, 1);
});

test('JSON bridge preserves adjacent text parts and separates reasoning summaries', async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: [
                { type: 'text', text: 'fix:' },
                { type: 'text', text: ' preserve parts' },
              ],
              reasoning_details: [{ text: 'first' }, { summary: 'second' }],
            },
          },
        ],
      }),
    );
  const result = await requestGeneration(config, request);
  assert.equal(result.content, 'fix: preserve parts');
  assert.equal(result.reasoning, 'first\nsecond');
});

for (const providerType of ['openai', 'custom']) {
  test(`${providerType} non-streaming requests omit streaming-only options`, async () => {
    globalThis.fetch = async (_url, init) => {
      const payload = JSON.parse(init.body);
      assert.equal(payload.stream, false);
      assert.equal(payload.stream_options, undefined);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'fix: use JSON' } }] }));
    };
    const result = await requestGeneration(
      {
        ...config,
        providerType,
        modelId: 'gpt-4o',
        extraBody: {
          stream: false,
          stream_options: { include_usage: true, include_obfuscation: false },
        },
      },
      request,
    );
    assert.equal(result.content, 'fix: use JSON');
  });
}

for (const details of [
  [{ text: 'step two\n' }],
  [{ type: 'thinking', text: 'step two\n' }],
  [{ type: 'reasoning.text', text: 'step two\n' }],
  [{ type: 'reasoning.summary', summary: 'step two\n' }],
]) {
  test(`mixed reasoning preserves ${details[0].type || 'legacy'} text in arrival order`, async () => {
    globalThis.fetch = async () =>
      sse(
        chunk({ reasoning_content: 'step one\n' }),
        chunk({ reasoning_details: details }),
        chunk({ reasoning_content: 'step three\n' }),
        chunk({ content: 'fix: complete' }, 'stop'),
        '[DONE]',
      );
    const deltas = [];
    const result = await requestGeneration(config, {
      ...request,
      stream: { onReasoningDelta: (text) => deltas.push(text) },
    });
    assert.equal(result.reasoning, 'step one\nstep two\nstep three\n');
    assert.deepEqual(deltas, ['step one\n', 'step two\n', 'step three\n']);
    assert.equal(
      result.piMessage.content.find((part) => part.type === 'thinking').thinking,
      result.reasoning,
    );
  });
}

test('duplicate reasoning fields in one event are emitted once, repeated later deltas are retained', async () => {
  globalThis.fetch = async () =>
    sse(
      chunk({
        reasoning_content: 'repeat ',
        reasoning_details: [{ type: 'reasoning.text', text: 'repeat ' }],
      }),
      chunk({ reasoning_content: 'repeat ', reasoning_details: [{ text: 'repeat ' }] }),
      chunk({ reasoning_content: 'third', reasoning_details: [{ summary: 'third and fourth' }] }),
      chunk({
        reasoning_content: ' fifth',
        reasoning_details: [
          { text: ' and sixth' },
          { type: 'reasoning.encrypted', data: 'opaque', text: 'never display' },
        ],
      }),
      chunk({ content: 'fix: deduplicate' }, 'stop'),
      '[DONE]',
    );
  const deltas = [];
  const result = await requestGeneration(config, {
    ...request,
    stream: { onReasoningDelta: (text) => deltas.push(text) },
  });
  assert.deepEqual(deltas, ['repeat ', 'repeat ', 'third and fourth', ' fifth and sixth']);
  assert.equal(result.reasoning, deltas.join(''));
  assert.doesNotMatch(result.reasoning, /opaque|never display/);
});

test('SSE compatibility conversion handles comments, CRLF and multiline JSON data', async () => {
  const bytes = Buffer.from(
    ': heartbeat\r\n\r\ndata: {"choices":[{\r\ndata: "delta":{"reasoning_details":[{"text":"检查"}]}}]}\r\n\r\n' +
      event(chunk({ content: 'fix: 修复' }, 'max_output_tokens')) +
      event('[DONE]'),
  );
  globalThis.fetch = async () =>
    new Response(
      new globalThis.ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3));
          controller.close();
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream', 'Content-Length': String(bytes.length) } },
    );
  const result = await requestGeneration(config, request);
  assert.equal(result.content, 'fix: 修复');
  assert.equal(result.reasoning, '检查');
  assert.equal(result.finishReason, 'length');
});

test('body interruption after a token-limit marker still fails without replay', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    let first = true;
    return new Response(
      new globalThis.ReadableStream({
        async pull(controller) {
          if (first) {
            first = false;
            controller.enqueue(Buffer.from(event(chunk({ content: 'partial' }, 'max_tokens'))));
          } else {
            await new Promise((resolve) => setTimeout(resolve, 5));
            controller.error(new TypeError('socket terminated after marker'));
          }
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  };
  await assert.rejects(requestGeneration(config, request), (err) => err.category === 'network');
  assert.equal(calls, 1);
});

test('malformed JSON and named SSE errors survive normalization without retries', async () => {
  for (const [body, category] of [
    ['data: not-json\n\n', 'response_format'],
    ['event: error\ndata: {"error":{"message":"provider rejected the request"}}\n\n', 'provider'],
  ]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    };
    await assert.rejects(requestGeneration(config, request), (err) => err.category === category);
    assert.equal(calls, 1);
  }
});
