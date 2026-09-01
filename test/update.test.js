import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { ERROR_CATEGORIES } from '../src/errors.js';
import { compareVersions, CURRENT_VERSION, PACKAGE_NAME, runUpdate } from '../src/update.js';

const CLI = fileURLToPath(new URL('../bin/aicommit.js', import.meta.url));

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '' };
}

function makeGlobalInstall(root, version = '2.2.3') {
  const globalRoot = join(root, 'global', 'node_modules');
  const packageRoot = join(globalRoot, '@hifullmoon', 'aicommit');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: PACKAGE_NAME, version }, null, 2)}\n`,
  );
  return { globalRoot, packageRoot };
}

test('version comparison follows SemVer ordering', () => {
  assert.ok(compareVersions('2.3.0', '2.2.3') > 0);
  assert.ok(compareVersions('2.3.0-beta.10', '2.3.0-beta.2') > 0);
  assert.ok(compareVersions('2.3.0', '2.3.0-beta.10') > 0);
  assert.equal(compareVersions('2.2.3', '2.2.3'), 0);
});

test('update exits without locating or changing the install when already current', () => {
  const calls = [];
  const result = runUpdate({
    currentVersion: '2.2.3',
    log() {},
    runner(args) {
      calls.push(args);
      return ok('"2.2.3"\n');
    },
  });

  assert.equal(result.exitReason, 'up_to_date');
  assert.equal(result.data.updated, false);
  assert.equal(result.data.installedVersion, '2.2.3');
  assert.deepEqual(calls, [['view', PACKAGE_NAME, 'dist-tags.latest', '--json']]);
});

test('update installs the exact registry version and verifies the installed manifest', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-update-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { globalRoot, packageRoot } = makeGlobalInstall(root);
  const calls = [];

  const result = runUpdate({
    currentVersion: '2.2.3',
    packageRoot,
    log() {},
    runner(args) {
      calls.push(args);
      if (args[0] === 'view') return ok('"2.3.0"\n');
      if (args[0] === 'root') return ok(`${globalRoot}\n`);
      if (args[0] === 'install') {
        writeFileSync(
          join(packageRoot, 'package.json'),
          `${JSON.stringify({ name: PACKAGE_NAME, version: '2.3.0' }, null, 2)}\n`,
        );
        return ok('updated 1 package\n');
      }
      throw new Error(`Unexpected npm args: ${args.join(' ')}`);
    },
  });

  assert.equal(result.exitReason, 'updated');
  assert.deepEqual(result.data, {
    packageName: PACKAGE_NAME,
    currentVersion: '2.2.3',
    latestVersion: '2.3.0',
    installedVersion: '2.3.0',
    updated: true,
  });
  assert.deepEqual(calls[2], [
    'install',
    '--global',
    `${PACKAGE_NAME}@2.3.0`,
    '--no-audit',
    '--no-fund',
  ]);
});

test('update does not downgrade a development version newer than npm latest', () => {
  const result = runUpdate({
    currentVersion: '2.4.0-beta.1',
    log() {},
    runner: () => ok('"2.3.0"'),
  });
  assert.equal(result.exitReason, 'newer_than_latest');
  assert.equal(result.data.updated, false);
});

test('update refuses a package outside the active npm global root', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-update-mismatch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { globalRoot } = makeGlobalInstall(root);
  const sourceRoot = join(root, 'checkout');
  mkdirSync(sourceRoot);

  assert.throws(
    () =>
      runUpdate({
        currentVersion: '2.2.3',
        packageRoot: sourceRoot,
        log() {},
        runner: (args) => (args[0] === 'view' ? ok('"2.3.0"') : ok(globalRoot)),
      }),
    (error) =>
      error.category === ERROR_CATEGORIES.CONFIG &&
      /different Node\.js or npm environment/.test(error.message),
  );
});

test(
  'update refuses an npm-linked source checkout',
  { skip: process.platform === 'win32' },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), 'aicommit-update-link-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const globalRoot = join(root, 'global', 'node_modules');
    const packageRoot = join(root, 'checkout');
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(join(globalRoot, '@hifullmoon'), { recursive: true });
    symlinkSync(packageRoot, join(globalRoot, '@hifullmoon', 'aicommit'));

    assert.throws(
      () =>
        runUpdate({
          currentVersion: '2.2.3',
          packageRoot,
          log() {},
          runner: (args) => (args[0] === 'view' ? ok('"2.3.0"') : ok(globalRoot)),
        }),
      (error) => error.category === ERROR_CATEGORIES.CONFIG && /npm-linked/.test(error.message),
    );
  },
);

test('update classifies npm availability, registry, and permission failures', (t) => {
  assert.throws(
    () =>
      runUpdate({
        log() {},
        runner: () => ({ status: null, stdout: '', stderr: '', error: { code: 'ENOENT' } }),
      }),
    (error) =>
      error.category === ERROR_CATEGORIES.CONFIG && /unavailable in PATH/.test(error.message),
  );

  assert.throws(
    () =>
      runUpdate({
        log() {},
        runner: () => ({ status: 1, stdout: '', stderr: 'npm error code ENOTFOUND' }),
      }),
    (error) => error.category === ERROR_CATEGORIES.NETWORK && /ENOTFOUND/.test(error.message),
  );

  const root = mkdtempSync(join(tmpdir(), 'aicommit-update-permission-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { globalRoot, packageRoot } = makeGlobalInstall(root);
  assert.throws(
    () =>
      runUpdate({
        currentVersion: '2.2.3',
        packageRoot,
        log() {},
        runner(args) {
          if (args[0] === 'view') return ok('"2.3.0"');
          if (args[0] === 'root') return ok(globalRoot);
          return { status: 1, stdout: '', stderr: 'npm error code EACCES' };
        },
      }),
    (error) =>
      error.category === ERROR_CATEGORIES.CONFIG && /global install directory/.test(error.message),
  );
});

test('update supports strict JSON output without requiring a Git repository', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-update-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const fakeNpm = join(root, 'fake-npm.js');
  mkdirSync(bin);
  writeFileSync(
    fakeNpm,
    `if (process.argv[2] === 'view') process.stdout.write(JSON.stringify('${CURRENT_VERSION}'));\nelse process.exitCode = 42;\n`,
  );
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${fakeNpm}" %*\r\n`);
  } else {
    const npm = join(bin, 'npm');
    writeFileSync(npm, `#!/bin/sh\nexec "${process.execPath}" "${fakeNpm}" "$@"\n`);
    chmodSync(npm, 0o755);
  }

  const result = spawnSync(process.execPath, [CLI, 'update', '--output=json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH || ''}`, NO_COLOR: '1' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.exitReason, 'up_to_date');
  assert.equal(output.data.currentVersion, CURRENT_VERSION);
  assert.equal(output.data.updated, false);
  assert.match(result.stderr, /Checking the npm registry/);
});
