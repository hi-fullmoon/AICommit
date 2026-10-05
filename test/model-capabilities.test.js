import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analysisConfig } from '../src/change-analysis.js';
import { getProviderAdapter } from '../src/providers.js';

test('OpenAI context limits bound large-change input budgets after SDK migration', () => {
  const config = {
    providerType: 'openai',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    modelId: 'gpt-4',
    maxTokens: 1024,
    reasoning: { mode: 'off' },
  };
  const small = analysisConfig(config);
  assert.equal(getProviderAdapter(config).model.contextWindow, 8192);
  assert.equal(small.analysisBudget.limits.chunkInputTokens, 6144);
  const large = analysisConfig({ ...config, modelId: 'gpt-4.1' });
  assert.equal(large.analysisBudget.limits.chunkInputTokens, 12000);
});

test('OpenRouter retains assistant reasoning field requirements from its model catalog', () => {
  for (const modelId of [
    'deepseek/deepseek-v4-flash',
    'deepseek/deepseek-v4-flash-0731',
    'deepseek/deepseek-v4-flash-0731:batch',
    'deepseek/deepseek-v4-flash-vision-exp',
    'deepseek/deepseek-v4-pro',
    'deepseek/deepseek-v4-pro-0813',
    'deepseek/deepseek-v4-pro-0813:batch',
    'moonshotai/kimi-k2.6',
    '~deepseek/deepseek-v4-flash-latest',
  ]) {
    const { model } = getProviderAdapter({
      providerType: 'openrouter',
      apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
      modelId,
    });
    assert.equal(model.requiresReasoningContentOnAssistantMessages, true, modelId);
  }
  const { model } = getProviderAdapter({
    providerType: 'openrouter',
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    modelId: 'openai/gpt-4o-mini',
  });
  assert.equal(model.requiresReasoningContentOnAssistantMessages, undefined);
});
