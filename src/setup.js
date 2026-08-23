import { readFile, writeFile, chmod, copyFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import chalk from 'chalk';
import ora from 'ora';
import input from '@inquirer/input';
import password from '@inquirer/password';
import confirm from '@inquirer/confirm';

import { checkConnection } from './api.js';
import { isSecureApiUrl } from './config.js';
import { vimSelect } from './ui.js';
import { fileExists, formatMs, indentError, maskApiKey } from './utils.js';

// Presets offered by the wizard. Each provides the endpoint and a sensible
// default model; the user can still override the model id in a later step.
const PROVIDER_PRESETS = [
  { name: 'openai',     apiUrl: 'https://api.openai.com/v1/chat/completions',       modelId: 'gpt-4o' },
  { name: 'deepseek',   apiUrl: 'https://api.deepseek.com/v1/chat/completions',     modelId: 'deepseek-v4-flash' },
  { name: 'openrouter', apiUrl: 'https://openrouter.ai/api/v1/chat/completions',    modelId: 'openai/gpt-4o-mini' },
  {
    name: 'minimax', apiUrl: 'https://api.minimaxi.com/v1/chat/completions', modelId: 'MiniMax-M3',
    extraBody: { thinking: { type: 'disabled' }, reasoning_split: true },
  },
];

// Top-level connection keys from a legacy flat config. When the wizard writes
// a providers map these are dropped from the top level, so the old flat
// values can't silently shadow or conflict with the provider entries.
const FLAT_CONNECTION_KEYS = ['apiUrl', 'apiKey', 'apiKeyEnv', 'modelId'];

// Merge the wizard's answers into an existing config object (or an empty
// one). Existing providers and unrelated settings are preserved; the new
// provider becomes the default. Pure — exported for tests.
export function mergeSetupConfig(existing, { providerName, entry, language }) {
  const result = { ...existing };

  // Legacy flat config: remove the top-level connection keys now that the
  // connection lives under providers[providerName].
  if (!result.providers) {
    for (const key of FLAT_CONNECTION_KEYS) delete result[key];
  }

  result.providers = { ...existing.providers, [providerName]: entry };
  result.defaultProvider = providerName;
  result.language = language;
  return result;
}

async function readExistingConfig(path) {
  if (!(await fileExists(path))) return {};
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed;
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

export async function runSetup() {
  console.log('');
  console.log('  ' + chalk.cyan.bold('⚡ aicommit setup ') + chalk.dim('interactive configuration'));
  console.log('  ' + chalk.dim('─'.repeat(45)));

  // Provider credentials are always user-owned. A repository may contain a
  // project config for harmless generation preferences, but it must never be
  // able to redirect a globally authenticated request.
  const targetPath = join(homedir(), '.aicommit.config.json');
  console.log(chalk.dim(`  Credentials will be stored in the user config: ${targetPath}`));

  const existing = await readExistingConfig(targetPath);

  // ── 2. Provider ─────────────────────────────────────────────────────

  const presetName = await vimSelect({
    message: 'Choose a provider',
    choices: [
      ...PROVIDER_PRESETS.map(p => ({
        name:        p.name,
        value:       p.name,
        description: `${p.apiUrl} — default model: ${p.modelId}`,
      })),
      { name: 'custom', value: 'custom', description: 'Any OpenAI-compatible endpoint' },
    ],
  });

  let providerName, apiUrl, defaultModel, presetExtraBody;
  if (presetName === 'custom') {
    providerName = await input({
      message:  'Provider name (used with aicommit -p <name>)',
      validate: v => /^[\w.-]+$/.test(v.trim()) || 'Use letters, digits, dot, dash or underscore',
    });
    providerName = providerName.trim();
    apiUrl = await input({
      message:  'API endpoint URL',
      validate: (v) => isSecureApiUrl(v.trim())
        || 'Use HTTPS, or HTTP only for localhost/loopback',
    });
    apiUrl = apiUrl.trim();
    defaultModel = '';
  } else {
    const preset = PROVIDER_PRESETS.find(p => p.name === presetName);
    providerName = preset.name;
    apiUrl       = preset.apiUrl;
    defaultModel = preset.modelId;
    presetExtraBody = preset.extraBody;
  }

  const existingProvider = existing.providers?.[providerName] || {};

  // ── 3. API key ──────────────────────────────────────────────────────

  const hasKey = Boolean(existingProvider.apiKey);
  const hasKeyEnv = Boolean(existingProvider.apiKeyEnv);
  // An empty key is allowed — local models (Ollama, LM Studio, LiteLLM) are
  // keyless; the optional connection test below still catches a missing key
  // for providers that require one.
  const keyInput = await password({
    message:  `API key for ${providerName}${hasKey
      ? ` (current: ${maskApiKey(existingProvider.apiKey)} — leave empty to keep)`
      : hasKeyEnv
        ? ` (current env: ${existingProvider.apiKeyEnv} — leave empty to keep)`
        : ' (use env:VARIABLE, or leave empty for local models)'}`,
    mask:     '*',
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

  const modelInput = await input({
    message:  'Model ID',
    default:  existingProvider.modelId || defaultModel || undefined,
    validate: v => v.trim() ? true : 'Model ID is required',
  });
  const modelId = modelInput.trim();

  // ── 5. Commit message language ──────────────────────────────────────

  const language = await vimSelect({
    message:  'Commit message language',
    default:  existing.language === 'en' ? 'en' : 'zh',
    choices: [
      { name: '中文 (zh)',   value: 'zh' },
      { name: 'English (en)', value: 'en' },
    ],
  });

  const entry = {
    ...existingProvider,
    apiUrl,
    apiKey,
    apiKeyEnv,
    modelId,
    ...(presetExtraBody && !existingProvider.extraBody ? { extraBody: presetExtraBody } : {}),
  };

  // ── 6. Connection test ──────────────────────────────────────────────

  const runTest = await confirm({
    message: 'Test the connection now?',
    default: true,
  });

  if (runTest) {
    const spinner = ora({
      text:  chalk.dim(`Checking ${chalk.bold(modelId)} ...`),
      color: 'cyan',
    }).start();

    try {
      const report = await checkConnection({
        ...entry,
        apiKey: apiKeyEnv ? process.env[apiKeyEnv] : apiKey,
        maxTokens: 64,
        timeoutMs: 120000,
      });
      spinner.succeed(`Connection OK — ${formatMs(report.elapsed)}`);
    } catch (err) {
      spinner.fail('Connection failed');
      console.log(`\n  ${indentError(err)}\n`);
      const saveAnyway = await confirm({
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
  // Write through a same-directory temporary file so interruption cannot
  // leave a partially written config. Permissions are tightened before the
  // atomic replacement as well as after it (best effort on Windows).
  await writeConfigAtomic(targetPath, merged);

  console.log('');
  console.log('  ' + chalk.green.bold('✓ Config saved'));
  console.log('  ' + chalk.dim(`  Path:     ${targetPath}`));
  console.log('  ' + chalk.dim(`  Provider: ${providerName} (${modelId})`));
  console.log('  ' + chalk.dim(`  API key:  ${apiKeyEnv ? `env:${apiKeyEnv}` : maskApiKey(apiKey)}`));
  console.log('');
  console.log(chalk.dim('  Run ') + chalk.bold('aicommit -c') + chalk.dim(' to verify the connection, or ') + chalk.bold('aicommit') + chalk.dim(' to start committing.'));
  console.log('');
}
