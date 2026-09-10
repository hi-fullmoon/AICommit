import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAnalysisCache } from '../src/analysis-cache.js';
import { DEFAULT_CONFIG } from '../src/config.js';

function repo(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'aicommit-analysis-cache-'));
  execFileSync('git', ['init', '-q'], { cwd });
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function config(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    apiUrl: 'https://example.test/v1/chat/completions',
    modelId: 'cache-test-model',
    reasoning: { ...DEFAULT_CONFIG.reasoning, mode: 'off' },
    largeChange: {
      ...DEFAULT_CONFIG.largeChange,
      strategy: 'deep',
      cache: { ...DEFAULT_CONFIG.largeChange.cache, ...overrides },
    },
  };
}

test('analysis cache stores only validated summaries and round-trips by chunk hash', (t) => {
  const cwd = repo(t);
  const cache = createAnalysisCache({
    projectRoot: cwd,
    snapshotFingerprint: 'a'.repeat(64),
    config: config(),
  });
  const input = [{ id: 'F1S0P1', text: 'RAW_DIFF_MUST_NOT_BE_STORED' }];
  const key = cache.keyFor('fragment-analysis', input);
  const groups = [{ ids: ['F1S0P1'], summary: 'Update cache behavior.' }];

  assert.equal(cache.write(key, ['F1S0P1'], groups), true);
  assert.deepEqual(cache.read(key, ['F1S0P1']), groups);
  assert.equal(cache.read(key, ['F2S0P1']), null);

  const file = join(cache.path, readdirSync(cache.path)[0]);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /RAW_DIFF_MUST_NOT_BE_STORED/);
  if (process.platform !== 'win32') assert.equal(lstatSync(file).mode & 0o777, 0o600);

  cache.clear();
  assert.equal(existsSync(cache.path), false);
});

test('analysis cache namespaces model settings and refuses unprotected persistence by default', (t) => {
  const cwd = repo(t);
  const snapshotFingerprint = 'b'.repeat(64);
  const first = createAnalysisCache({
    projectRoot: cwd,
    snapshotFingerprint,
    config: config(),
  });
  const second = createAnalysisCache({
    projectRoot: cwd,
    snapshotFingerprint,
    config: { ...config(), modelId: 'different-model' },
  });
  const changedSnapshot = createAnalysisCache({
    projectRoot: cwd,
    snapshotFingerprint: 'e'.repeat(64),
    config: config(),
  });
  const unprotected = createAnalysisCache({
    projectRoot: cwd,
    snapshotFingerprint,
    config: config(),
    protect: false,
  });
  const disabled = createAnalysisCache({
    projectRoot: cwd,
    snapshotFingerprint,
    config: config({ enabled: false }),
  });
  const allowed = createAnalysisCache({
    projectRoot: cwd,
    snapshotFingerprint,
    config: config({ allowUnprotected: true }),
    protect: false,
  });

  assert.notEqual(first.path, second.path);
  assert.notEqual(first.path, changedSnapshot.path);
  assert.equal(unprotected, null);
  assert.equal(disabled, null);
  assert.ok(allowed);
});

test('analysis cache treats corrupt entries as misses and prunes expired namespaces', (t) => {
  const cwd = repo(t);
  const settings = { ttlMs: 1000 };
  const expired = createAnalysisCache({
    projectRoot: cwd,
    snapshotFingerprint: 'c'.repeat(64),
    config: config(settings),
  });
  const key = expired.keyFor('fragment-analysis', [{ id: 'F1S0P1', text: 'x' }]);
  expired.write(key, ['F1S0P1'], [{ ids: ['F1S0P1'], summary: 'summary' }]);
  const file = join(expired.path, `${key}.json`);
  writeFileSync(file, '{not-json', 'utf8');
  assert.equal(expired.read(key, ['F1S0P1']), null);
  writeFileSync(file, Buffer.alloc(128 * 1024 + 1));
  assert.equal(expired.read(key, ['F1S0P1']), null);
  if (process.platform !== 'win32') {
    rmSync(file);
    const target = join(cwd, 'outside-cache.json');
    writeFileSync(target, JSON.stringify({ groups: [] }), 'utf8');
    symlinkSync(target, file);
    assert.equal(expired.read(key, ['F1S0P1']), null);
    rmSync(file);
    writeFileSync(file, '{not-json', 'utf8');
  }

  const old = new Date(Date.now() - 5000);
  utimesSync(file, old, old);
  utimesSync(expired.path, old, old);
  createAnalysisCache({
    projectRoot: cwd,
    snapshotFingerprint: 'd'.repeat(64),
    config: config(settings),
  });
  assert.equal(existsSync(expired.path), false);
});
