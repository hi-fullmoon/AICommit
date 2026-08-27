import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUNDLED_PROVIDER_PRESET_PATH } from '../src/provider-presets.js';

const CLI = fileURLToPath(new URL('../bin/aicommit.js', import.meta.url));

function runCli(cwd, home, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    encoding: 'utf8',
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('preset CLI validates, installs, reports, and rolls back independent manifests', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-preset-command-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const base = JSON.parse(readFileSync(BUNDLED_PROVIDER_PRESET_PATH, 'utf8'));
  const first = JSON.parse(JSON.stringify(base));
  first.version = '1.1.0';
  first.providers[0].models[first.providers[0].defaultModel].modelId = 'first-model';
  const second = JSON.parse(JSON.stringify(base));
  second.version = '1.2.0';
  second.providers[0].models[second.providers[0].defaultModel].modelId = 'second-model';
  const firstPath = join(root, 'first.json');
  const secondPath = join(root, 'second.json');
  writeFileSync(firstPath, JSON.stringify(first));
  writeFileSync(secondPath, JSON.stringify(second));

  const paths = runCli(root, home, ['preset', 'path', '--output=json']);
  assert.equal(paths.code, 0, paths.stdout + paths.stderr);
  assert.equal(JSON.parse(paths.stdout).data.paths.user.exists, false);

  const valid = runCli(root, home, ['preset', 'validate', `--file=${firstPath}`, '--output=json']);
  assert.equal(valid.code, 0, valid.stdout + valid.stderr);
  assert.equal(JSON.parse(valid.stdout).data.version, '1.1.0');

  for (const path of [firstPath, secondPath]) {
    const installed = runCli(root, home, ['preset', 'install', `--file=${path}`, '--output=json']);
    assert.equal(installed.code, 0, installed.stdout + installed.stderr);
  }
  let shown = runCli(root, home, ['preset', 'show', '--output=json']);
  assert.equal(shown.code, 0, shown.stdout + shown.stderr);
  let shownProvider = JSON.parse(shown.stdout).data.manifest.providers[0];
  assert.equal(shownProvider.models[shownProvider.defaultModel].modelId, 'second-model');

  const rolledBack = runCli(root, home, ['preset', 'rollback', '--output=json']);
  assert.equal(rolledBack.code, 0, rolledBack.stdout + rolledBack.stderr);
  shown = runCli(root, home, ['preset', 'show', '--output=json']);
  shownProvider = JSON.parse(shown.stdout).data.manifest.providers[0];
  assert.equal(shownProvider.models[shownProvider.defaultModel].modelId, 'first-model');

  const invalid = JSON.parse(JSON.stringify(base));
  invalid.providers[0].apiKey = 'secret-value-must-not-leak';
  const invalidPath = join(root, 'invalid.json');
  writeFileSync(invalidPath, JSON.stringify(invalid));
  const rejected = runCli(root, home, [
    'preset',
    'validate',
    `--file=${invalidPath}`,
    '--output=json',
  ]);
  assert.equal(rejected.code, 2, rejected.stdout + rejected.stderr);
  assert.equal(JSON.parse(rejected.stdout).error.category, 'config');
  assert.doesNotMatch(rejected.stdout + rejected.stderr, /secret-value-must-not-leak/);
});
