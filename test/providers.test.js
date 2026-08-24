import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectProviderType, getProviderAdapter, normalizeUsage } from '../src/providers.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'providers');
const fixtureFiles = (await readdir(fixtureDir)).filter((name) => name.endsWith('.json')).sort();
const fixtures = await Promise.all(
  fixtureFiles.map(async (name) => JSON.parse(await readFile(join(fixtureDir, name), 'utf8'))),
);

test('provider contract fixture matrix builds requests and normalizes responses', () => {
  let parsed = 0;
  for (const fixture of fixtures) {
    const adapter = getProviderAdapter(fixture.config);
    assert.deepEqual(adapter.buildRequest(fixture.request), fixture.expectedRequest, fixture.name);
    assert.deepEqual(adapter.capabilities, fixture.expectedCapabilities, fixture.name);
    assert.deepEqual(adapter.headers, fixture.expectedHeaders, fixture.name);

    const { raw, ...normalized } = adapter.normalizeResponse(fixture.response);
    assert.equal(raw, fixture.response, `${fixture.name}: raw response is retained`);
    assert.deepEqual(normalized, fixture.expectedResponse, fixture.name);
    if (normalized.content) parsed += 1;
  }

  assert.ok(fixtures.length >= 6, 'all required provider families are represented');
  assert.ok(parsed / fixtures.length >= 0.995, 'valid-response parse rate is at least 99.5%');
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
