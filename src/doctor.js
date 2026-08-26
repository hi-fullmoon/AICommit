import { execFileSync } from 'node:child_process';

import chalk from 'chalk';

import { checkConnection } from './api.js';
import { loadConfig, isSecureApiUrl } from './config.js';
import { classifyError, ERROR_CATEGORIES, fail } from './errors.js';
import { getProviderAdapter } from './providers.js';
import { configureExtensionHost, resolveProviderAdapter } from './extensions.js';
import { formatMs, formatUsage, redactSensitiveUrl, sanitizeTerminalText } from './utils.js';

function nodeSupported(version = process.versions.node) {
  return Number(version.split('.')[0]) >= 18;
}

function renderCheck(check) {
  const icon = check.status === 'pass' ? chalk.green('✓') : check.status === 'warn' ? '⚠' : '✗';
  const color =
    check.status === 'pass' ? chalk.dim : check.status === 'warn' ? chalk.yellow : chalk.red;
  console.log(`  ${icon} ${color(`${check.name}: ${sanitizeTerminalText(check.message)}`)}`);
}

function addCheck(checks, name, status, message) {
  const check = { name, status, message };
  checks.push(check);
  renderCheck(check);
}

function gitVersion() {
  return execFileSync('git', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export async function runDoctor(cliProvider = null) {
  const checks = [];
  const warnings = [];
  console.log('\n  ' + chalk.cyan.bold('Doctor diagnostics'));
  console.log('  ' + chalk.dim('─'.repeat(45)));

  const nodeVersion = process.versions.node;
  addCheck(
    checks,
    'Node.js',
    nodeSupported(nodeVersion) ? 'pass' : 'fail',
    `v${nodeVersion}${nodeSupported(nodeVersion) ? ' (supported)' : ' (requires >=18)'}`,
  );

  try {
    addCheck(checks, 'Git', 'pass', gitVersion());
  } catch (err) {
    addCheck(checks, 'Git', 'fail', err.message);
    const failure = fail(ERROR_CATEGORIES.GIT_STATE, `Git is unavailable: ${err.message}`, {
      cause: err,
      reported: true,
    });
    throw failure;
  }

  let loadedConfig;
  try {
    loadedConfig = await loadConfig(cliProvider);
  } catch (err) {
    const classified = classifyError(err);
    addCheck(checks, 'Config', 'fail', classified.message);
    classified.reported = true;
    throw classified;
  }

  const { config, loaded, providerName, credentialSourceLabel, credentialWarning } = loadedConfig;
  const extensionHost = await configureExtensionHost(config);
  const adapter = await resolveProviderAdapter(config, getProviderAdapter);
  const provider = providerName || adapter.id;
  addCheck(checks, 'Config', 'pass', loaded.length ? loaded.join(' + ') : 'built-in defaults');
  addCheck(
    checks,
    'Endpoint security',
    isSecureApiUrl(config.apiUrl) ? 'pass' : 'fail',
    isSecureApiUrl(config.apiUrl)
      ? redactSensitiveUrl(config.apiUrl)
      : 'insecure endpoint rejected',
  );
  addCheck(
    checks,
    'Provider capabilities',
    'pass',
    `${provider}; stream=${adapter.capabilities.streaming}, reasoning=${adapter.capabilities.reasoning}, ` +
      `tokens=${adapter.capabilities.tokenBudget}, usage=${adapter.capabilities.usage}, ` +
      `finishReason=${adapter.capabilities.finishReason}`,
  );
  addCheck(checks, 'Credentials', credentialWarning ? 'warn' : 'pass', credentialSourceLabel);
  if (credentialWarning) warnings.push(credentialWarning);
  if (extensionHost.extensions.length) {
    addCheck(
      checks,
      'Extensions',
      'pass',
      extensionHost.extensions.map((item) => `${item.id}@${item.version}`).join(', '),
    );
  }

  let report;
  try {
    report = await checkConnection(config);
    const usage = report.usage ? `; tokens=${formatUsage(report.usage)}` : '';
    addCheck(
      checks,
      'Connectivity',
      'pass',
      `${formatMs(report.elapsed)}; model=${report.model || config.modelId}${usage}`,
    );
  } catch (err) {
    const classified = classifyError(err);
    addCheck(checks, 'Connectivity', 'fail', classified.message);
    classified.reported = true;
    throw classified;
  }

  console.log('\n  ' + chalk.green.bold(`✓ Doctor passed (${checks.length} checks)\n`));
  return {
    message: `doctor: ${checks.length} checks passed`,
    provider,
    model: config.modelId,
    latencyMs: report.elapsed,
    usage: report.usage,
    warnings,
    exitReason: 'doctor_ok',
    committed: false,
  };
}
