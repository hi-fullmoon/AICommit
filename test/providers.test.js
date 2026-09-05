import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { requestGeneration } from '../src/api.js';

import {
  canDisableReasoningForModel,
  detectProviderType,
  normalizeUsage,
  reasoningEffortsForModel,
  REASONING_EFFORTS,
} from '../src/providers.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'providers');
const fixtureFiles = (await readdir(fixtureDir)).filter((name) => name.endsWith('.json')).sort();
const fixtures = await Promise.all(
  fixtureFiles.map(async (name) => JSON.parse(await readFile(join(fixtureDir, name), 'utf8'))),
);

test('provider contract fixture matrix runs through Pi AI and normalizes responses', async () => {
  for (const fixture of fixtures) {
    let sent;
    globalThis.fetch = async (url, init) => {
      assert.equal(url, fixture.config.apiUrl);
      sent = JSON.parse(init.body);
      for (const [key, value] of Object.entries(fixture.expectedHeaders)) {
        assert.equal(init.headers.get(key), value);
      }
      return new Response(JSON.stringify(fixture.response));
    };
    const result = await requestGeneration(
      { ...fixture.config, extraBody: fixture.request.extraBody },
      {
        ...fixture.request,
        stream: fixture.request.streaming ? { onReasoningDelta() {} } : null,
      },
    );
    // Per-model extraBody comes from resolved configuration in real requests.
    assert.equal(result.piMessage.api, 'openai-completions', fixture.name);
    assert.deepEqual(sent, fixture.expectedRequest, fixture.name);
    assert.deepEqual(result.capabilities, fixture.expectedCapabilities, fixture.name);
    assert.deepEqual(result.raw, fixture.response);
    const {
      raw: _raw,
      piMessage: _piMessage,
      capabilities: _capabilities,
      attempts: _attempts,
      latencyMs: _latencyMs,
      ...normalized
    } = result;
    assert.deepEqual(normalized, fixture.expectedResponse, fixture.name);
  }
});

test('provider detection distinguishes native Ollama from its compatible /v1 endpoint', () => {
  assert.equal(detectProviderType('http://localhost:11434/api/chat'), 'ollama');
  assert.equal(detectProviderType('http://localhost:11434/v1/chat/completions'), 'custom');
  assert.equal(detectProviderType('https://gateway.example.test/chat', 'DeepSeek'), 'deepseek');
  assert.throws(
    () => detectProviderType('https://gateway.example.test/chat', 'unknown'),
    /Unknown providerType/,
  );
});

test('setup effort choices follow known OpenAI model limits', () => {
  assert.deepEqual(reasoningEffortsForModel('openai', 'o3'), ['low', 'medium', 'high']);
  assert.deepEqual(reasoningEffortsForModel('openai', 'gpt-5.1-codex'), ['low', 'medium', 'high']);
  assert.deepEqual(reasoningEffortsForModel('openai', 'gpt-5.6-sol'), REASONING_EFFORTS);
  assert.deepEqual(reasoningEffortsForModel('openrouter', 'openai/o3'), ['low', 'medium', 'high']);
  assert.equal(canDisableReasoningForModel('openai', 'o3'), false);
  assert.equal(canDisableReasoningForModel('openai', 'gpt-5.1-codex'), true);
  assert.equal(canDisableReasoningForModel('openrouter', 'openai/o3'), true);
});

test('usage normalization accepts OpenAI, Anthropic, Ollama, and total-only shapes', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }), {
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
  });
  assert.deepEqual(normalizeUsage({ input_tokens: 4, output_tokens: 5 }), {
    inputTokens: 4,
    outputTokens: 5,
    totalTokens: 9,
  });
  assert.deepEqual(normalizeUsage({ prompt_eval_count: 6, eval_count: 7 }), {
    inputTokens: 6,
    outputTokens: 7,
    totalTokens: 13,
  });
  assert.deepEqual(normalizeUsage({ total_tokens: 8 }), { totalTokens: 8 });
  assert.equal(normalizeUsage({}), null);
});
