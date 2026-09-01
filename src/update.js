import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import chalk from 'chalk';

import { ERROR_CATEGORIES, fail } from './errors.js';

const require = createRequire(import.meta.url);
const manifest = require('../package.json');

export const PACKAGE_NAME = manifest.name;
export const CURRENT_VERSION = manifest.version;

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);
const PERMISSION_CODES = new Set(['EACCES', 'EPERM']);

function parseVersion(version) {
  const match = SEMVER.exec(version || '');
  if (!match) throw new Error(`Invalid semantic version: ${version || '(empty)'}`);
  const prerelease = match[4]?.split('.') || [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    throw new Error(`Invalid semantic version: ${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function compareVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) return left[field] - right[field];
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const comparison = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function npmInvocation(args, platform = process.platform, env = process.env) {
  if (platform !== 'win32') return { command: 'npm', args };
  if (!args.every((arg) => /^[0-9A-Za-z@_./:-]+$/.test(arg))) {
    throw new Error('Refusing to pass an unsafe argument to npm.cmd.');
  }
  return {
    command: env.ComSpec || env.COMSPEC || 'cmd.exe',
    args: ['/d', '/c', `npm.cmd ${args.join(' ')}`],
  };
}

export function runNpm(args, options = {}) {
  const platform = options.platform || process.platform;
  const invocation = npmInvocation(args, platform, options.env || process.env);
  return spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8',
    env: options.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: args[0] === 'install' ? 300_000 : 30_000,
    windowsHide: true,
  });
}

function resultText(result) {
  return `${result?.stderr || ''}\n${result?.stdout || ''}`;
}

function npmErrorCode(result) {
  const text = resultText(result);
  const npmCode = /(?:npm ERR!|npm error)\s+code\s+([A-Z0-9_-]+)/i.exec(text)?.[1];
  if (npmCode) return npmCode.toUpperCase();
  return /\b(EACCES|EPERM|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)\b/i
    .exec(text)?.[1]
    ?.toUpperCase();
}

function runCheckedNpm(args, runner, action, debug, log) {
  if (debug) log(chalk.dim(`  npm ${args.join(' ')}`));
  let result;
  try {
    result = runner(args);
  } catch (error) {
    throw fail(ERROR_CATEGORIES.CONFIG, `Unable to start npm while ${action}.`, { cause: error });
  }
  if (result?.error?.code === 'ENOENT') {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      'npm is unavailable in PATH. Install npm or select the Node.js environment that installed aicommit.',
      { cause: result.error },
    );
  }
  if (result?.error) {
    const category = NETWORK_CODES.has(result.error.code)
      ? ERROR_CATEGORIES.NETWORK
      : ERROR_CATEGORIES.CONFIG;
    throw fail(category, `npm failed while ${action} (${result.error.code || 'unknown error'}).`, {
      cause: result.error,
    });
  }
  if (result?.status !== 0) {
    const code = npmErrorCode(result);
    if (PERMISSION_CODES.has(code)) {
      throw fail(
        ERROR_CATEGORIES.CONFIG,
        `npm cannot write its global install directory (${code}). Fix npm global permissions and try again.`,
      );
    }
    const category =
      action === 'checking the registry' || NETWORK_CODES.has(code)
        ? ERROR_CATEGORIES.NETWORK
        : ERROR_CATEGORIES.CONFIG;
    throw fail(
      category,
      `npm failed while ${action}${code ? ` (${code})` : ''}. ` +
        (action === 'checking the registry'
          ? 'Check the configured registry, authentication, proxy, and network connection.'
          : `Run "npm install --global ${PACKAGE_NAME}@latest" manually for full npm diagnostics.`),
    );
  }
  return String(result.stdout || '').trim();
}

function latestVersionFrom(output) {
  let value;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw fail(ERROR_CATEGORIES.NETWORK, 'npm returned invalid metadata for the latest version.', {
      cause: error,
    });
  }
  if (typeof value !== 'string') {
    throw fail(ERROR_CATEGORIES.NETWORK, 'npm returned invalid metadata for the latest version.');
  }
  try {
    parseVersion(value);
  } catch (error) {
    throw fail(ERROR_CATEGORIES.NETWORK, `npm returned an invalid latest version: ${value}.`, {
      cause: error,
    });
  }
  return value;
}

function normalizedRealPath(path, platform) {
  const value = realpathSync.native(path);
  return platform === 'win32' ? value.toLowerCase() : value;
}

function assertActiveGlobalInstall(globalRoot, packageRoot, platform) {
  const expectedPackageRoot = join(globalRoot, PACKAGE_NAME);
  let expectedStat;
  try {
    expectedStat = lstatSync(expectedPackageRoot);
  } catch (error) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      `Cannot safely self-update this installation. The active npm global root does not contain ${PACKAGE_NAME}. ` +
        `Reinstall it with "npm install --global ${PACKAGE_NAME}@latest".`,
      { cause: error },
    );
  }
  if (expectedStat.isSymbolicLink()) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      'Cannot self-update an npm-linked source checkout. Update the checkout manually, or replace the link with a global npm installation.',
    );
  }
  let activePath;
  let currentPath;
  try {
    activePath = normalizedRealPath(expectedPackageRoot, platform);
    currentPath = normalizedRealPath(packageRoot, platform);
  } catch (error) {
    throw fail(ERROR_CATEGORIES.CONFIG, 'Cannot resolve the active aicommit installation.', {
      cause: error,
    });
  }
  if (activePath !== currentPath) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      'Cannot safely self-update this installation because it belongs to a different Node.js or npm environment. ' +
        `Activate the environment that installed it, or run "npm install --global ${PACKAGE_NAME}@latest" manually.`,
    );
  }
}

function installedVersion(packageRoot) {
  try {
    const value = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
    parseVersion(value);
    return value;
  } catch (error) {
    throw fail(
      ERROR_CATEGORIES.INTERNAL,
      'The npm update finished, but the installed aicommit version could not be verified.',
      { cause: error },
    );
  }
}

export function runUpdate(options = {}) {
  const currentVersion = options.currentVersion || CURRENT_VERSION;
  const packageRoot = options.packageRoot || PACKAGE_ROOT;
  const platform = options.platform || process.platform;
  const runner = options.runner || ((args) => runNpm(args, { platform }));
  const log = options.log || console.log;
  const debug = Boolean(options.debug);

  parseVersion(currentVersion);
  log('');
  log('  ' + chalk.cyan.bold('Update aicommit'));
  log('  ' + chalk.dim('─'.repeat(45)));
  log(chalk.dim('  Checking the npm registry...'));

  const latestVersion = latestVersionFrom(
    runCheckedNpm(
      ['view', PACKAGE_NAME, 'dist-tags.latest', '--json'],
      runner,
      'checking the registry',
      debug,
      log,
    ),
  );
  log(`  Current version: ${chalk.bold(currentVersion)}`);
  log(`  Latest version:  ${chalk.bold(latestVersion)}`);

  const comparison = compareVersions(currentVersion, latestVersion);
  if (comparison >= 0) {
    const newer = comparison > 0;
    const message = newer
      ? `aicommit ${currentVersion} is newer than npm latest ${latestVersion}.`
      : `aicommit ${currentVersion} is already up to date.`;
    log('\n  ' + chalk.green('✓') + ` ${message}\n`);
    return {
      message,
      warnings: [],
      exitReason: newer ? 'newer_than_latest' : 'up_to_date',
      committed: false,
      data: {
        packageName: PACKAGE_NAME,
        currentVersion,
        latestVersion,
        installedVersion: currentVersion,
        updated: false,
      },
    };
  }

  const globalRoot = runCheckedNpm(
    ['root', '--global'],
    runner,
    'locating the global installation',
    debug,
    log,
  );
  assertActiveGlobalInstall(globalRoot, packageRoot, platform);

  log(chalk.dim(`\n  Installing ${PACKAGE_NAME}@${latestVersion}...`));
  runCheckedNpm(
    ['install', '--global', `${PACKAGE_NAME}@${latestVersion}`, '--no-audit', '--no-fund'],
    runner,
    'installing the update',
    debug,
    log,
  );

  const verifiedVersion = installedVersion(packageRoot);
  if (verifiedVersion !== latestVersion) {
    throw fail(
      ERROR_CATEGORIES.INTERNAL,
      `npm completed, but aicommit is still at ${verifiedVersion} instead of ${latestVersion}. ` +
        'Check which aicommit executable is first in PATH.',
    );
  }

  const message = `Updated aicommit from ${currentVersion} to ${verifiedVersion}.`;
  log('\n  ' + chalk.green('✓') + ` ${message}\n`);
  return {
    message,
    warnings: [],
    exitReason: 'updated',
    committed: false,
    data: {
      packageName: PACKAGE_NAME,
      currentVersion,
      latestVersion,
      installedVersion: verifiedVersion,
      updated: true,
    },
  };
}
