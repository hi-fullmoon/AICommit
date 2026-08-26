import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertProviderPresetCompatibility,
  BUNDLED_PROVIDER_PRESET_PATH,
  installProviderPresetManifest,
  loadProviderPresetManifest,
  providerPresetPaths,
  rollbackProviderPresetManifest,
  validateProviderPresetManifest,
} from '../src/provider-presets.js';
import { runPresetCommand } from '../src/preset-command.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('bundled provider presets are strict, versioned, and core-compatible', async () => {
  const loaded = await loadProviderPresetManifest({
    path: BUNDLED_PROVIDER_PRESET_PATH,
    coreVersion: '1.4.0',
  });
  assert.equal(loaded.manifest.kind, 'aicommit-provider-presets');
  assert.equal(loaded.manifest.schemaVersion, 1);
  assert.match(loaded.manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(loaded.manifest.compatibility.adapterContract, 1);
  assert.ok(loaded.manifest.providers.length >= 5);
  assert.ok(loaded.manifest.providers.every((provider) => !Object.hasOwn(provider, 'apiKey')));
  assert.deepEqual(
    loaded.manifest.providers.find((provider) => provider.id === 'kimi-code'),
    {
      id: 'kimi-code',
      label: 'Kimi Code',
      adapter: 'custom',
      apiUrl: 'https://api.kimi.com/coding/v1/chat/completions',
      modelId: 'kimi-for-coding',
    },
  );

  const raw = JSON.parse(await readFile(BUNDLED_PROVIDER_PRESET_PATH, 'utf8'));
  assert.deepEqual(validateProviderPresetManifest(raw), loaded.manifest);
  assert.equal(assertProviderPresetCompatibility(raw, '1.99.0'), raw);
  assert.equal(assertProviderPresetCompatibility(raw, '1.4.1-beta.1'), raw);
  assert.equal(assertProviderPresetCompatibility(raw, '1.4.1-beta.1+build.7'), raw);
  assert.equal(assertProviderPresetCompatibility(raw, '2.0.0-rc.1'), raw);
  assert.throws(() => assertProviderPresetCompatibility(raw, '1.4.0-beta.1'), /requires aicommit/);
  assert.throws(
    () => assertProviderPresetCompatibility(raw, '1.4.1-beta.01'),
    /must be a semantic version/,
  );
  assert.throws(() => assertProviderPresetCompatibility(raw, '2.0.0'), /requires aicommit/);
});

test('preset validation rejects credentials, unsafe endpoints, dialect overrides, and bad contracts', async () => {
  const base = (
    await loadProviderPresetManifest({
      path: BUNDLED_PROVIDER_PRESET_PATH,
      coreVersion: '1.4.0',
    })
  ).manifest;

  const credential = clone(base);
  credential.providers[0].apiKey = 'must-not-be-accepted';
  assert.throws(() => validateProviderPresetManifest(credential), /unknown properties: apiKey/);

  const endpoint = clone(base);
  endpoint.providers[0].apiUrl = 'http://remote.example.test/v1/chat/completions';
  assert.throws(() => validateProviderPresetManifest(endpoint), /HTTPS/);

  const embeddedCredential = clone(base);
  embeddedCredential.providers[0].apiUrl =
    'https://user:password@api.example.test/v1/chat/completions';
  assert.throws(() => validateProviderPresetManifest(embeddedCredential), /HTTPS/);

  const dialect = clone(base);
  dialect.providers[0].extraBody = { model: 'replacement' };
  assert.throws(() => validateProviderPresetManifest(dialect), /forbidden property: model/);

  const authorization = clone(base);
  authorization.providers[0].extraBody = { nested: { authorization: 'secret' } };
  assert.throws(
    () => validateProviderPresetManifest(authorization),
    /forbidden property: authorization/,
  );

  const adapter = clone(base);
  adapter.providers[0].adapter = 'unknown';
  assert.throws(() => validateProviderPresetManifest(adapter), /adapter contract v1/);

  const duplicate = clone(base);
  duplicate.providers[1].id = duplicate.providers[0].id;
  assert.throws(() => validateProviderPresetManifest(duplicate), /must be unique/);

  const incompatible = clone(base);
  incompatible.compatibility.coreMinimum = '2.0.0';
  incompatible.compatibility.coreMaximumExclusive = '3.0.0';
  assert.throws(
    () => assertProviderPresetCompatibility(incompatible, '1.4.0'),
    /requires aicommit/,
  );
});

test('user preset installs are atomic, preferred over bundled data, and rollbackable', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'aicommit-provider-presets-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const base = (
    await loadProviderPresetManifest({
      path: BUNDLED_PROVIDER_PRESET_PATH,
      coreVersion: '1.4.0',
    })
  ).manifest;
  const first = clone(base);
  first.version = '1.1.0';
  first.providers[0].modelId = 'preset-first';
  const second = clone(base);
  second.version = '1.2.0';
  second.providers[0].modelId = 'preset-second';
  const firstPath = join(home, 'first.json');
  const secondPath = join(home, 'second.json');
  await writeFile(firstPath, JSON.stringify(first));
  await writeFile(secondPath, JSON.stringify(second));

  await installProviderPresetManifest(firstPath, { home, coreVersion: '1.4.0' });
  let active = await loadProviderPresetManifest({ home, coreVersion: '1.4.0' });
  assert.equal(active.source, 'user');
  assert.equal(active.manifest.version, '1.1.0');

  await installProviderPresetManifest(secondPath, { home, coreVersion: '1.4.0' });
  active = await loadProviderPresetManifest({ home, coreVersion: '1.4.0' });
  assert.equal(active.manifest.version, '1.2.0');
  const paths = providerPresetPaths(home);
  assert.equal(JSON.parse(await readFile(paths.backup, 'utf8')).version, '1.1.0');

  await rollbackProviderPresetManifest({ home, coreVersion: '1.4.0' });
  active = await loadProviderPresetManifest({ home, coreVersion: '1.4.0' });
  assert.equal(active.manifest.version, '1.1.0');
  assert.equal(JSON.parse(await readFile(paths.backup, 'utf8')).version, '1.2.0');
  if (process.platform !== 'win32') {
    assert.equal((await stat(paths.user)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.backup)).mode & 0o777, 0o600);
  }

  const report = await runPresetCommand('show', { home, machineOutput: true });
  assert.equal(report.data.source, 'user');
  assert.equal(report.data.version, '1.1.0');
  assert.equal(report.data.manifest.providers[0].modelId, 'preset-first');

  await writeFile(paths.user, '{invalid json\n');
  const repaired = await installProviderPresetManifest(secondPath, {
    home,
    coreVersion: '1.4.0',
  });
  assert.ok(repaired.invalidBackupPath);
  assert.equal(await readFile(repaired.invalidBackupPath, 'utf8'), '{invalid json\n');
  active = await loadProviderPresetManifest({ home, coreVersion: '1.4.0' });
  assert.equal(active.manifest.version, '1.2.0');
});
