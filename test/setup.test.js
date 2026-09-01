import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
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
  loadProviderPresetManifest({ path: BUNDLED_PROVIDER_PRESET_PATH, coreVersion: '1.5.1' });

function unexpectedPrompt(kind, question) {
  assert.fail(`Unexpected ${kind} prompt: ${question.message}`);
}

const entry = {
  providerType: 'deepseek',
  apiUrl: 'https://api.deepseek.com/v1/chat/completions',
  apiKey: 'sk-test',
  defaultModel: 'chat',
  models: { chat: { modelId: 'deepseek-chat' } },
};

test('mergeSetupConfig creates a fresh config from an empty file', () => {
  const r = mergeSetupConfig({}, { providerName: 'deepseek', entry, language: 'zh' });
  assert.deepEqual(r.providers, { deepseek: entry });
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.defaultProvider, 'deepseek');
  assert.equal(r.language, 'zh');
});

test('mergeSetupConfig preserves existing providers and unrelated settings', () => {
  const existing = {
    schemaVersion: 1,
    providers: {
      openai: {
        providerType: 'openai',
        apiUrl: 'https://api.openai.com/v1/chat/completions',
        apiKey: 'sk-old',
        defaultModel: 'default',
        models: { default: { modelId: 'gpt-4o' } },
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
  const existing = {
    schemaVersion: 1,
    providers: {
      deepseek: {
        providerType: 'deepseek',
        apiUrl: 'https://old.example.test/v1',
        defaultModel: 'old',
        models: { old: { modelId: 'old' } },
      },
    },
  };
  const r = mergeSetupConfig(existing, { providerName: 'deepseek', entry, language: 'zh' });
  assert.deepEqual(r.providers.deepseek, entry);
});

test('mergeSetupConfig writes the canonical schema and keeps global settings', () => {
  const existing = { schemaVersion: 1, providers: {}, temperature: 0.5 };
  const r = mergeSetupConfig(existing, { providerName: 'deepseek', entry, language: 'zh' });
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.temperature, 0.5);
  assert.deepEqual(r.providers, { deepseek: entry });
});

test('mergeSetupConfig does not mutate the input', () => {
  const existing = {
    schemaVersion: 1,
    providers: {
      openai: {
        providerType: 'openai',
        apiUrl: 'https://api.openai.com/v1/chat/completions',
        apiKey: 'sk-old',
        defaultModel: 'default',
        models: { default: { modelId: 'gpt-4o' } },
      },
    },
  };
  mergeSetupConfig(existing, { providerName: 'deepseek', entry, language: 'zh' });
  assert.equal(existing.providers.openai.apiKey, 'sk-old');
  assert.deepEqual(Object.keys(existing.providers), ['openai']);
});

test('runSetup saves a preset provider atomically with environment credentials', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const targetPath = join(root, '.aicommit', 'config.json');
  const previousKey = process.env.AICOMMIT_SETUP_TEST_KEY;
  process.env.AICOMMIT_SETUP_TEST_KEY = 'secret-from-env';
  t.after(() => {
    if (previousKey === undefined) delete process.env.AICOMMIT_SETUP_TEST_KEY;
    else process.env.AICOMMIT_SETUP_TEST_KEY = previousKey;
  });

  const modelNames = ['gpt-4o', 'quality'];
  let addAnotherCount = 0;
  const effortPrompts = [];
  const spinnerEvents = [];
  await runSetup({
    targetPath,
    selectPrompt: async (question) => {
      if (question.message === 'Choose a provider') return 'openai';
      if (question.message === 'Reasoning mode for gpt-4o') {
        assert.equal(question.default, 'auto');
        return 'off';
      }
      if (question.message === 'Reasoning mode for quality') {
        assert.equal(question.default, 'on');
        assert.deepEqual(
          question.choices.map((choice) => choice.value),
          ['auto', 'on'],
          'o3 cannot disable reasoning',
        );
        return 'on';
      }
      if (question.message === 'Reasoning effort for quality') {
        effortPrompts.push(question.message);
        assert.equal(question.default, 'medium');
        assert.deepEqual(
          question.choices.map((choice) => choice.value),
          ['low', 'medium', 'high'],
          'known OpenAI models only offer supported effort levels',
        );
        return question.default;
      }
      if (question.message === 'Choose the default model') return 'quality';
      if (question.message === 'Commit message language') return 'en';
      return unexpectedPrompt('select', question);
    },
    inputPrompt: async (question) => {
      if (question.message === 'Model name (used with aicommit -m <name>)') {
        return modelNames.shift();
      }
      if (question.message === 'Model ID for gpt-4o') return 'gpt-test';
      if (question.message === 'Model ID for quality') return 'o3';
      return unexpectedPrompt('input', question);
    },
    passwordPrompt: async () => 'env:AICOMMIT_SETUP_TEST_KEY',
    confirmPrompt: async (question) => {
      if (question.message === 'Add another model?') return addAnotherCount++ === 0;
      if (question.message === 'Test the connection now?') return true;
      return unexpectedPrompt('confirm', question);
    },
    connectionCheck: async (config) => {
      assert.equal(config.apiKey, 'secret-from-env');
      assert.equal(config.modelId, 'o3');
      assert.deepEqual(config.reasoning, {
        mode: 'on',
        effort: 'medium',
        maxTokens: 4096,
        maxDisplayChars: 12000,
      });
      return { elapsed: 42 };
    },
    spinnerFactory: () => ({
      start() {
        return this;
      },
      succeed(message) {
        spinnerEvents.push(message);
      },
      fail() {
        assert.fail('connection check should succeed');
      },
    }),
    presetLoader: bundledPresetLoader,
  });

  const saved = JSON.parse(readFileSync(targetPath, 'utf-8'));
  assert.equal(saved.defaultProvider, 'openai');
  assert.equal(saved.language, 'en');
  assert.deepEqual(saved.providers.openai, {
    providerType: 'openai',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    apiKeyEnv: 'AICOMMIT_SETUP_TEST_KEY',
    defaultModel: 'quality',
    models: {
      'gpt-4o': { label: 'GPT-4o', modelId: 'gpt-test', reasoning: { mode: 'off' } },
      'gpt-5.6-sol': { label: 'GPT-5.6 Sol', modelId: 'gpt-5.6-sol' },
      'gpt-5.6-terra': { label: 'GPT-5.6 Terra', modelId: 'gpt-5.6-terra' },
      'gpt-5.6-luna': { label: 'GPT-5.6 Luna', modelId: 'gpt-5.6-luna' },
      quality: { modelId: 'o3', reasoning: { mode: 'on', effort: 'medium' } },
    },
  });
  assert.deepEqual(effortPrompts, ['Reasoning effort for quality']);
  if (process.platform !== 'win32') {
    assert.equal(statSync(targetPath).mode & 0o777, 0o600);
  }
  assert.deepEqual(readdirSync(root), ['.aicommit']);
  assert.deepEqual(readdirSync(join(root, '.aicommit')), ['config.json']);
  assert.deepEqual(spinnerEvents, ['Connection OK — 42ms']);
});

test('runSetup migrates a valid legacy user config to the canonical path', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-setup-legacy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const legacyPath = join(root, '.aicommit.config.json');
  const canonicalPath = join(root, '.aicommit', 'config.json');
  writeFileSync(
    legacyPath,
    JSON.stringify({
      schemaVersion: 1,
      defaultProvider: 'openai',
      providers: {
        openai: {
          providerType: 'openai',
          apiUrl: 'https://api.openai.com/v1/chat/completions',
          apiKey: 'legacy-key',
          defaultModel: 'quality',
          models: {
            quality: {
              modelId: 'legacy-model',
              reasoning: { mode: 'on', effort: 'high' },
            },
          },
        },
      },
      temperature: 0.3,
    }),
  );

  await runSetup({
    home: root,
    selectPrompt: async (question) => {
      if (question.message === 'Choose a provider') return 'openai';
      if (question.message === 'Reasoning mode for quality') {
        assert.equal(question.default, 'on');
        return question.default;
      }
      if (question.message === 'Reasoning effort for quality') {
        assert.equal(question.default, 'high', 'existing model effort is used as the default');
        assert.deepEqual(
          question.choices.map((choice) => choice.value),
          ['low', 'medium', 'high'],
        );
        return question.default;
      }
      if (question.message === 'Choose the default model') return 'quality';
      if (question.message === 'Commit message language') return 'en';
      return unexpectedPrompt('select', question);
    },
    inputPrompt: async (question) => {
      if (question.message === 'Model name (used with aicommit -m <name>)') return 'quality';
      if (question.message === 'Model ID for quality') return 'gpt-5.1-codex';
      return unexpectedPrompt('input', question);
    },
    passwordPrompt: async () => '',
    confirmPrompt: async (question) => {
      if (question.message === 'Add another model?') return false;
      if (question.message === 'Test the connection now?') return false;
      return unexpectedPrompt('confirm', question);
    },
    spinnerFactory: () => assert.fail('connection test should not run'),
    presetLoader: bundledPresetLoader,
  });

  const migrated = JSON.parse(readFileSync(canonicalPath, 'utf8'));
  assert.equal(migrated.temperature, 0.3);
  assert.equal(migrated.providers.openai.apiKey, 'legacy-key');
  assert.deepEqual(migrated.providers.openai.models.quality, {
    modelId: 'gpt-5.1-codex',
    reasoning: { mode: 'on', effort: 'high' },
  });
  assert.equal(readFileSync(legacyPath, 'utf8').includes('legacy-model'), true);
});

test('runSetup preserves invalid config and cancels after a failed connection test', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-setup-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const targetPath = join(root, '.aicommit', 'config.json');
  mkdirSync(join(root, '.aicommit'));
  writeFileSync(targetPath, '{invalid json\n');
  chmodSync(targetPath, 0o600);

  const spinnerEvents = [];
  let checkedConfig;
  await runSetup({
    targetPath,
    selectPrompt: async (question) => {
      if (question.message === 'Choose a provider') return 'deepseek';
      if (question.message === 'Reasoning mode for chat') {
        assert.equal(question.default, 'on');
        return 'auto';
      }
      if (question.message === 'Choose the default model') return 'chat';
      if (question.message === 'Commit message language') return 'zh';
      return unexpectedPrompt('select', question);
    },
    inputPrompt: async (question) => {
      if (question.message === 'Model name (used with aicommit -m <name>)') return 'chat';
      if (question.message === 'Model ID for chat') return 'deepseek-test';
      return unexpectedPrompt('input', question);
    },
    passwordPrompt: async () => '',
    confirmPrompt: async (question) => {
      if (question.message === 'Add another model?') return false;
      if (question.message === 'Test the connection now?') return true;
      if (question.message === 'Save the config anyway?') return false;
      return unexpectedPrompt('confirm', question);
    },
    connectionCheck: async (config) => {
      checkedConfig = config;
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
  const backup = readdirSync(join(root, '.aicommit')).find((name) => name.includes('.invalid-'));
  assert.ok(backup, 'invalid source config is backed up');
  assert.equal(readFileSync(join(root, '.aicommit', backup), 'utf-8'), '{invalid json\n');
  assert.deepEqual(checkedConfig.reasoning, {
    mode: 'auto',
    effort: 'medium',
    maxTokens: 4096,
    maxDisplayChars: 12000,
  });
  assert.deepEqual(spinnerEvents, [['fail', 'Connection failed']]);
});

test('runSetup stops on structurally invalid JSON config without replacing it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-setup-structure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const targetPath = join(root, '.aicommit', 'config.json');
  mkdirSync(join(root, '.aicommit'));
  const original = JSON.stringify({ schemaVersion: 999, providers: {} });
  writeFileSync(targetPath, original);

  await assert.rejects(
    () =>
      runSetup({
        targetPath,
        selectPrompt: async () => assert.fail('wizard must not start'),
        presetLoader: async () => assert.fail('presets must not load'),
      }),
    /valid JSON but has an unsupported structure.*Fix it or move it aside/,
  );

  assert.equal(readFileSync(targetPath, 'utf8'), original);
  assert.deepEqual(readdirSync(join(root, '.aicommit')), ['config.json']);
});

test('setup discovers a new compatible provider only from preset data', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-setup-preset-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const targetPath = join(root, '.aicommit', 'config.json');
  const base = (await bundledPresetLoader()).manifest;
  const manifest = JSON.parse(JSON.stringify(base));
  manifest.version = '2.1.0';
  manifest.providers = [
    {
      id: 'acme',
      label: 'Acme Compatible',
      adapter: 'custom',
      apiUrl: 'https://api.acme.example/v1/chat/completions',
      defaultModel: 'default',
      models: { default: { modelId: 'acme-default' } },
    },
  ];
  validateProviderPresetManifest(manifest);
  let providerChoices;
  await runSetup({
    targetPath,
    presetLoader: async () => ({ manifest, path: 'test', source: 'file' }),
    selectPrompt: async (question) => {
      if (question.message === 'Choose a provider') {
        providerChoices = question.choices;
        return 'acme';
      }
      if (question.message === 'Reasoning mode for default') {
        assert.equal(question.default, 'auto');
        return 'auto';
      }
      if (question.message === 'Commit message language') return 'en';
      return unexpectedPrompt('select', question);
    },
    inputPrompt: async (question) => {
      if (question.message === 'Model name (used with aicommit -m <name>)') return 'default';
      if (question.message === 'Model ID for default') return 'acme-v2';
      return unexpectedPrompt('input', question);
    },
    passwordPrompt: async () => '',
    confirmPrompt: async (question) => {
      if (question.message === 'Add another model?') return false;
      if (question.message === 'Test the connection now?') return false;
      return unexpectedPrompt('confirm', question);
    },
  });

  assert.ok(providerChoices.some((choice) => choice.value === 'acme'));
  const saved = JSON.parse(readFileSync(targetPath, 'utf8'));
  assert.deepEqual(saved.providers.acme, {
    providerType: 'custom',
    apiUrl: 'https://api.acme.example/v1/chat/completions',
    apiKey: '',
    apiKeyEnv: '',
    defaultModel: 'default',
    models: { default: { modelId: 'acme-v2', reasoning: { mode: 'auto' } } },
  });
});
