import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeSetupConfig } from '../src/setup.js';

const entry = {
  apiUrl: 'https://api.deepseek.com/v1/chat/completions',
  apiKey: 'sk-test',
  modelId: 'deepseek-chat',
};

test('mergeSetupConfig creates a fresh config from an empty file', () => {
  const r = mergeSetupConfig({}, { providerName: 'deepseek', entry, language: 'zh' });
  assert.deepEqual(r.providers, { deepseek: entry });
  assert.equal(r.defaultProvider, 'deepseek');
  assert.equal(r.language, 'zh');
});

test('mergeSetupConfig preserves existing providers and unrelated settings', () => {
  const existing = {
    providers: { openai: { apiUrl: 'https://api.openai.com/v1/chat/completions', apiKey: 'sk-old', modelId: 'gpt-4o' } },
    defaultProvider: 'openai',
    maxTokens: 2048,
    stripFiles: ['*.map'],
  };
  const r = mergeSetupConfig(existing, { providerName: 'deepseek', entry, language: 'en' });
  assert.deepEqual(Object.keys(r.providers).sort(), ['deepseek', 'openai']);
  assert.deepEqual(r.providers.openai, existing.providers.openai);
  assert.equal(r.defaultProvider, 'deepseek');
  assert.equal(r.language, 'en');
  assert.equal(r.maxTokens, 2048);
  assert.deepEqual(r.stripFiles, ['*.map']);
});

test('mergeSetupConfig overwrites a same-named provider', () => {
  const existing = { providers: { deepseek: { apiUrl: 'old', apiKey: 'old', modelId: 'old' } } };
  const r = mergeSetupConfig(existing, { providerName: 'deepseek', entry, language: 'zh' });
  assert.deepEqual(r.providers.deepseek, entry);
});

test('mergeSetupConfig drops flat legacy connection keys', () => {
  const existing = {
    apiUrl: 'https://legacy.example.com/v1/chat/completions',
    apiKey: 'sk-legacy',
    modelId: 'legacy-model',
    temperature: 0.5,
  };
  const r = mergeSetupConfig(existing, { providerName: 'deepseek', entry, language: 'zh' });
  assert.equal(r.apiUrl, undefined);
  assert.equal(r.apiKey, undefined);
  assert.equal(r.modelId, undefined);
  // Non-connection top-level settings stay as shared defaults.
  assert.equal(r.temperature, 0.5);
  assert.deepEqual(r.providers, { deepseek: entry });
});

test('mergeSetupConfig does not mutate the input', () => {
  const existing = { providers: { openai: { apiKey: 'sk-old' } }, apiKey: 'sk-flat' };
  mergeSetupConfig(existing, { providerName: 'deepseek', entry, language: 'zh' });
  assert.deepEqual(existing, { providers: { openai: { apiKey: 'sk-old' } }, apiKey: 'sk-flat' });
});
