import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, validateConfig } from '../src/config.js';

const cfg = (extra = {}) => ({
  ...DEFAULT_CONFIG,
  ...extra,
  reasoning: { ...DEFAULT_CONFIG.reasoning, ...extra.reasoning },
});

test('validateConfig accepts the default config', () => {
  assert.equal(validateConfig(cfg()).modelId, DEFAULT_CONFIG.modelId);
});

test('validateConfig rejects invalid scalar config values early', () => {
  assert.throws(() => validateConfig(cfg({ maxTokens: '1024' })), /maxTokens/);
  assert.throws(() => validateConfig(cfg({ timeoutMs: 0 })), /timeoutMs/);
  assert.throws(() => validateConfig(cfg({ temperature: 3 })), /temperature/);
  assert.throws(() => validateConfig(cfg({ apiUrl: 'not a url' })), /apiUrl/);
});

test('validateConfig rejects invalid collection and boolean config values', () => {
  assert.throws(() => validateConfig(cfg({ stripFiles: '*.map' })), /stripFiles/);
  assert.throws(() => validateConfig(cfg({ stripFiles: ['*.map', 42] })), /stripFiles/);
  assert.throws(() => validateConfig(cfg({ regenerateWithDiff: 'false' })), /regenerateWithDiff/);
  assert.throws(() => validateConfig(cfg({ extraBody: [] })), /extraBody/);
  assert.throws(() => validateConfig(cfg({ extraBody: null })), /extraBody/);
  assert.throws(() => validateConfig(cfg({ extraBody: { model: 'other' } })), /extraBody/);
});

test('validateConfig validates split-specific tuning options', () => {
  assert.equal(validateConfig(cfg({ splitMaxDiffChars: 12000, splitMaxPlanFiles: 50 })).splitMaxPlanFiles, 50);
  assert.throws(() => validateConfig(cfg({ splitMaxDiffChars: 0 })), /splitMaxDiffChars/);
  assert.throws(() => validateConfig(cfg({ splitMaxPlanFiles: 1.5 })), /splitMaxPlanFiles/);
});

test('validateConfig validates reasoning settings', () => {
  assert.equal(validateConfig(cfg()).reasoning.mode, 'on');
  assert.equal(validateConfig(cfg({ reasoning: { mode: 'on', effort: 'high', maxTokens: 8192 } })).reasoning.effort, 'high');
  assert.throws(() => validateConfig(cfg({ reasoning: { mode: 'sometimes', effort: 'low', maxTokens: 4096 } })), /reasoning\.mode/);
  assert.throws(() => validateConfig(cfg({ reasoning: { mode: 'on', effort: 'extreme', maxTokens: 4096 } })), /reasoning\.effort/);
  assert.throws(() => validateConfig(cfg({ reasoning: { mode: 'on', effort: 'low', maxTokens: 0 } })), /maxTokens/);
  assert.throws(() => validateConfig(cfg({ reasoning: { maxDisplayChars: 0 } })), /maxDisplayChars/);
});
