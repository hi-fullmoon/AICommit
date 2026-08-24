import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mergeSetupConfig, runSetup } from '../src/setup.js';
import {
  BUNDLED_PROVIDER_PRESET_PATH,
  loadProviderPresetManifest,
  validateProviderPresetManifest,
} from '../src/provider-presets.js';

const bundledPresetLoader = () =>
  loadProviderPresetManifest({ path: BUNDLED_PROVIDER_PRESET_PATH, coreVersion: '1.3.0' });

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
    providers: {
      openai: {
        apiUrl: 'https://api.openai.com/v1/chat/completions',
        apiKey: 'sk-old',
        modelId: 'gpt-4o',
      },
    },
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
    apiKeyEnv: 'LEGACY_API_KEY',
    modelId: 'legacy-model',
    temperature: 0.5,
  };
  const r = mergeSetupConfig(existing, { providerName: 'deepseek', entry, language: 'zh' });
  assert.equal(r.apiUrl, undefined);
  assert.equal(r.apiKey, undefined);
  assert.equal(r.apiKeyEnv, undefined);
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

test('runSetup saves a preset provider atomically with environment credentials', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const targetPath = join(root, '.aicommit.config.json');
  const previousKey = process.env.AICOMMIT_SETUP_TEST_KEY;
  process.env.AICOMMIT_SETUP_TEST_KEY = 'secret-from-env';
  t.after(() => {
    if (previousKey === undefined) delete process.env.AICOMMIT_SETUP_TEST_KEY;
    else process.env.AICOMMIT_SETUP_TEST_KEY = previousKey;
  });

  const selections = ['openai', 'en'];
  await runSetup({
    targetPath,
    selectPrompt: async () => selections.shift(),
    inputPrompt: async () => 'gpt-test',
    passwordPrompt: async () => 'env:AICOMMIT_SETUP_TEST_KEY',
    confirmPrompt: async () => false,
    presetLoader: bundledPresetLoader,
  });

  const saved = JSON.parse(readFileSync(targetPath, 'utf-8'));
  assert.equal(saved.defaultProvider, 'openai');
  assert.equal(saved.language, 'en');
  assert.deepEqual(saved.providers.openai, {
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    apiKeyEnv: 'AICOMMIT_SETUP_TEST_KEY',
    modelId: 'gpt-test',
    providerType: 'openai',
  });
  if (process.platform !== 'win32') {
    assert.equal(statSync(targetPath).mode & 0o777, 0o600);
  }
  assert.deepEqual(readdirSync(root), ['.aicommit.config.json']);
});

test('runSetup preserves invalid config and cancels after a failed connection test', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-setup-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const targetPath = join(root, '.aicommit.config.json');
  writeFileSync(targetPath, '{invalid json\n');
  chmodSync(targetPath, 0o600);

  const selections = ['deepseek', 'zh'];
  const confirmations = [true, false];
  const spinnerEvents = [];
  await runSetup({
    targetPath,
    selectPrompt: async () => selections.shift(),
    inputPrompt: async () => 'deepseek-test',
    passwordPrompt: async () => '',
    confirmPrompt: async () => confirmations.shift(),
    connectionCheck: async () => {
      throw new Error('offline test provider');
    },
    spinnerFactory: () => ({
      start() {
        return this;
      },
      succeed(message) {
        spinnerEvents.push(['succeed', message]);
      },
      fail(message) {
        spinnerEvents.push(['fail', message]);
      },
    }),
    presetLoader: bundledPresetLoader,
  });

  assert.equal(readFileSync(targetPath, 'utf-8'), '{invalid json\n');
  const backup = readdirSync(root).find((name) => name.includes('.invalid-'));
  assert.ok(backup, 'invalid source config is backed up');
  assert.equal(readFileSync(join(root, backup), 'utf-8'), '{invalid json\n');
  assert.deepEqual(spinnerEvents, [['fail', 'Connection failed']]);
});

test('setup discovers a new compatible provider only from preset data', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-setup-preset-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const targetPath = join(root, '.aicommit.config.json');
  const base = (await bundledPresetLoader()).manifest;
  const manifest = JSON.parse(JSON.stringify(base));
  manifest.version = '1.1.0';
  manifest.providers = [
    {
      id: 'acme',
      label: 'Acme Compatible',
      adapter: 'custom',
      apiUrl: 'https://api.acme.example/v1/chat/completions',
      modelId: 'acme-default',
    },
  ];
  validateProviderPresetManifest(manifest);
  const selections = ['acme', 'en'];
  let providerChoices;
  await runSetup({
    targetPath,
    presetLoader: async () => ({ manifest, path: 'test', source: 'file' }),
    selectPrompt: async (question) => {
      if (question.message === 'Choose a provider') providerChoices = question.choices;
      return selections.shift();
    },
    inputPrompt: async () => 'acme-v2',
    passwordPrompt: async () => '',
    confirmPrompt: async () => false,
  });

  assert.ok(providerChoices.some((choice) => choice.value === 'acme'));
  const saved = JSON.parse(readFileSync(targetPath, 'utf8'));
  assert.deepEqual(saved.providers.acme, {
    apiUrl: 'https://api.acme.example/v1/chat/completions',
    apiKey: '',
    apiKeyEnv: '',
    modelId: 'acme-v2',
    providerType: 'custom',
  });
});
