import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProviderAdapter } from '../src/providers.js';
import { analysisOutputTokenLimit } from '../src/change-analysis.js';

test('MiniMax M3.1 maps configured effort and retains reasoning on follow-up', () => {
  const adapter = getProviderAdapter({
    apiUrl: 'https://api.minimaxi.com/v1/chat/completions',
    modelId: 'MiniMax-M3.1-Flash',
  });
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const reasoning = { mode: 'on', effort };
    const options = adapter.options({ reasoning, maxTokens: 4096 });
    const payload = {};
    options.onPayload(payload);
    assert.equal(payload.reasoning_effort, effort);
    assert.equal(payload.reasoning_split, true);
    assert.equal(adapter.reasoningForFollowUp(reasoning).mode, 'on');
  }
  const payload = {};
  adapter.options({ reasoning: { mode: 'auto' } }).onPayload(payload);
  assert.equal(payload.reasoning_effort, undefined);
});

test('structured analysis respects the configured reasoning output ceiling', () => {
  assert.equal(analysisOutputTokenLimit({ maxTokens: 2048 }), 4096);
  assert.equal(
    analysisOutputTokenLimit({ maxTokens: 2048, reasoning: { mode: 'on', maxTokens: 8192 } }),
    8192,
  );
  assert.equal(
    analysisOutputTokenLimit({ maxTokens: 1024, reasoning: { mode: 'off', maxTokens: 8192 } }),
    1024,
  );
});
