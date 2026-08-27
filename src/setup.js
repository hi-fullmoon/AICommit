import { readFile, writeFile, chmod, copyFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import chalk from 'chalk';
import ora from 'ora';
import input from '@inquirer/input';
import password from '@inquirer/password';
import confirm from '@inquirer/confirm';

import { checkConnection } from './api.js';
import { CONFIG_SCHEMA_VERSION, isSecureApiUrl, validateUserConfig } from './config.js';
import { vimSelect } from './ui.js';
import { fileExists, formatMs, indentError, maskApiKey } from './utils.js';
import { loadProviderPresetManifest } from './provider-presets.js';

// Merge the wizard's answers into the one supported Provider/Model schema.
// Existing providers and unrelated global settings are preserved; the
// configured provider becomes the default. Pure — exported for tests.
export function mergeSetupConfig(existing, { providerName, entry, language }) {
  const result = { ...existing };
  result.schemaVersion = CONFIG_SCHEMA_VERSION;
  result.providers = { ...existing.providers, [providerName]: entry };
  result.defaultProvider = providerName;
  result.language = language;
  return result;
}

async function readExistingConfig(path) {
  if (!(await fileExists(path))) return {};
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'));
    return validateUserConfig(parsed);
  } catch (err) {
    const backup = `${path}.invalid-${Date.now()}.bak`;
    await copyFile(path, backup);
    console.log(chalk.yellow(`  ⚠ Could not parse ${path} (${err.message}) — starting fresh.`));
    console.log(chalk.dim(`    The original file was preserved at ${backup}.`));
    return {};
  }
}

async function writeConfigAtomic(path, value) {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await chmod(tempPath, 0o600).catch(() => {});
    await rename(tempPath, path);
    await chmod(path, 0o600).catch(() => {});
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    throw err;
  }
}

export async function runSetup(dependencies = {}) {
  const {
    targetPath = join(homedir(), '.aicommit.config.json'),
    selectPrompt = vimSelect,
    inputPrompt = input,
    passwordPrompt = password,
    confirmPrompt = confirm,
    connectionCheck = checkConnection,
    spinnerFactory = ora,
    presetLoader = loadProviderPresetManifest,
  } = dependencies;

  console.log('');
  console.log(
    '  ' + chalk.cyan.bold('⚡ aicommit setup ') + chalk.dim('interactive configuration'),
  );
  console.log('  ' + chalk.dim('─'.repeat(45)));

  // Provider credentials are always user-owned. A repository may contain a
  // project config for harmless generation preferences, but it must never be
  // able to redirect a globally authenticated request.
  console.log(chalk.dim(`  Credentials will be stored in the user config: ${targetPath}`));

  const existing = await readExistingConfig(targetPath);
  const { manifest: presetManifest } = await presetLoader();
  const providerPresets = presetManifest.providers;

  // ── 2. Provider ─────────────────────────────────────────────────────

  const presetName = await selectPrompt({
    message: 'Choose a provider',
    choices: [
      ...providerPresets.map((p) => ({
        name: p.label,
        value: p.id,
        description:
          `${p.apiUrl} — default model: ` +
          `${p.models[p.defaultModel].label || p.models[p.defaultModel].modelId}`,
      })),
      { name: 'custom', value: 'custom', description: 'Any OpenAI-compatible endpoint' },
    ],
  });

  let providerName, apiUrl, presetAdapter, presetModels, presetDefaultModel;
  if (presetName === 'custom') {
    providerName = await inputPrompt({
      message: 'Provider name (used with aicommit -p <name>)',
      validate: (v) => /^[\w.-]+$/.test(v.trim()) || 'Use letters, digits, dot, dash or underscore',
    });
    providerName = providerName.trim();
    apiUrl = await inputPrompt({
      message: 'API endpoint URL',
      validate: (v) => isSecureApiUrl(v.trim()) || 'Use HTTPS, or HTTP only for localhost/loopback',
    });
    apiUrl = apiUrl.trim();
    presetModels = {};
    presetDefaultModel = 'default';
  } else {
    const preset = providerPresets.find((p) => p.id === presetName);
    if (!preset) throw new Error(`Provider preset not found: ${presetName}`);
    providerName = preset.id;
    apiUrl = preset.apiUrl;
    presetAdapter = preset.adapter;
    presetModels = preset.models;
    presetDefaultModel = preset.defaultModel;
  }

  const existingProvider = existing.providers?.[providerName] || {};

  // ── 3. API key ──────────────────────────────────────────────────────

  const hasKey = Boolean(existingProvider.apiKey);
  const hasKeyEnv = Boolean(existingProvider.apiKeyEnv);
  // An empty key is allowed — local models (Ollama, LM Studio, LiteLLM) are
  // keyless; the optional connection test below still catches a missing key
  // for providers that require one.
  const keyInput = await passwordPrompt({
    message: `API key for ${providerName}${
      hasKey
        ? ` (current: ${maskApiKey(existingProvider.apiKey)} — leave empty to keep)`
        : hasKeyEnv
          ? ` (current env: ${existingProvider.apiKeyEnv} — leave empty to keep)`
          : ' (use env:VARIABLE, or leave empty for local models)'
    }`,
    mask: '*',
  });
  const enteredKey = keyInput.trim();
  let apiKey = existingProvider.apiKey || '';
  let apiKeyEnv = existingProvider.apiKeyEnv || '';
  if (/^env:/i.test(enteredKey)) {
    apiKeyEnv = enteredKey.slice(4).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
      throw new Error('Invalid environment variable name after env:.');
    }
    if (!process.env[apiKeyEnv]) {
      throw new Error(`Environment variable "${apiKeyEnv}" is not set.`);
    }
    apiKey = '';
  } else if (enteredKey) {
    apiKey = enteredKey;
    apiKeyEnv = '';
  }

  // ── 4. Model ────────────────────────────────────────────────────────

  const models = { ...presetModels, ...existingProvider.models };
  let suggestedModel = existingProvider.defaultModel || presetDefaultModel;
  while (true) {
    const modelNameInput = await inputPrompt({
      message: 'Model name (used with aicommit -m <name>)',
      default: suggestedModel,
      validate: (v) =>
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v.trim()) ||
        'Use 1-64 letters, digits, dots, dashes, or underscores',
    });
    const modelName = modelNameInput.trim();
    const currentModel = models[modelName] || {};
    const modelIdInput = await inputPrompt({
      message: `Model ID for ${modelName}`,
      default: currentModel.modelId || undefined,
      validate: (v) => (v.trim() ? true : 'Model ID is required'),
    });
    models[modelName] = { ...currentModel, modelId: modelIdInput.trim() };
    const addAnother = await confirmPrompt({
      message: 'Add another model?',
      default: false,
    });
    if (!addAnother) break;
    suggestedModel = undefined;
  }

  const modelNames = Object.keys(models);
  const defaultModel =
    modelNames.length === 1
      ? modelNames[0]
      : await selectPrompt({
          message: 'Choose the default model',
          default: existingProvider.defaultModel || presetDefaultModel,
          choices: modelNames.map((name) => ({
            name: `${name} (${models[name].modelId})`,
            value: name,
          })),
        });
  const selectedModel = models[defaultModel];

  // ── 5. Commit message language ──────────────────────────────────────

  const language = await selectPrompt({
    message: 'Commit message language',
    default: existing.language === 'en' ? 'en' : 'zh',
    choices: [
      { name: '中文 (zh)', value: 'zh' },
      { name: 'English (en)', value: 'en' },
    ],
  });

  const entry = {
    apiUrl,
    apiKey,
    apiKeyEnv,
    providerType: presetAdapter || existingProvider.providerType || 'custom',
    defaultModel,
    models,
    ...(existingProvider.retry ? { retry: existingProvider.retry } : {}),
    ...(existingProvider.credentialHelper
      ? { credentialHelper: existingProvider.credentialHelper }
      : {}),
  };

  // ── 6. Connection test ──────────────────────────────────────────────

  const runTest = await confirmPrompt({
    message: 'Test the connection now?',
    default: true,
  });
  let connectionVerified = false;

  if (runTest) {
    const spinner = spinnerFactory({
      text: chalk.dim(`Checking ${chalk.bold(selectedModel.modelId)} ...`),
      color: 'cyan',
    }).start();

    try {
      const report = await connectionCheck({
        ...entry,
        ...selectedModel,
        apiKey: apiKeyEnv ? process.env[apiKeyEnv] : apiKey,
        maxTokens: 64,
        timeoutMs: 120000,
      });
      spinner.succeed(`Connection OK — ${formatMs(report.elapsed)}`);
      connectionVerified = true;
    } catch (err) {
      spinner.fail('Connection failed');
      console.log(`\n  ${indentError(err)}\n`);
      const saveAnyway = await confirmPrompt({
        message: 'Save the config anyway?',
        default: false,
      });
      if (!saveAnyway) {
        console.log(chalk.dim('\n  Setup cancelled — nothing was saved.\n'));
        return;
      }
    }
  }

  // ── 7. Write config ─────────────────────────────────────────────────

  const merged = mergeSetupConfig(existing, { providerName, entry, language });
  validateUserConfig(merged);
  // Write through a same-directory temporary file so interruption cannot
  // leave a partially written config. Permissions are tightened before the
  // atomic replacement as well as after it (best effort on Windows).
  await writeConfigAtomic(targetPath, merged);

  console.log('');
  console.log('  ' + chalk.green.bold('✓ Config saved'));
  console.log('  ' + chalk.dim(`  Path:     ${targetPath}`));
  console.log(
    '  ' + chalk.dim(`  Provider: ${providerName}/${defaultModel} (${selectedModel.modelId})`),
  );
  console.log(
    '  ' + chalk.dim(`  API key:  ${apiKeyEnv ? `env:${apiKeyEnv}` : maskApiKey(apiKey)}`),
  );
  console.log('');
  if (connectionVerified) {
    console.log(chalk.dim('  Connection verified. Run ') + chalk.bold('aicommit') + chalk.dim('.'));
  } else {
    console.log(
      chalk.dim('  Run ') +
        chalk.bold('aicommit doctor') +
        chalk.dim(' to verify the setup, or ') +
        chalk.bold('aicommit') +
        chalk.dim(' to start committing.'),
    );
  }
  console.log('');
}
