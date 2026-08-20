import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, validateConfig } from '../src/config.js';

const cfg = (extra = {}) => ({ ...DEFAULT_CONFIG, ...extra });

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
});

test('validateConfig validates split-specific tuning options', () => {
  assert.equal(validateConfig(cfg({ splitMaxDiffChars: 12000, splitMaxPlanFiles: 50 })).splitMaxPlanFiles, 50);
  assert.throws(() => validateConfig(cfg({ splitMaxDiffChars: 0 })), /splitMaxDiffChars/);
  assert.throws(() => validateConfig(cfg({ splitMaxPlanFiles: 1.5 })), /splitMaxPlanFiles/);
});
