import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  assertProviderPresetCompatibility,
  BUNDLED_PROVIDER_PRESET_PATH,
  loadProviderPresetManifest,
  validateProviderPresetManifest,
} from '../src/provider-presets.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('bundled provider presets are strict, versioned, and core-compatible', async () => {
  const loaded = await loadProviderPresetManifest({
    path: BUNDLED_PROVIDER_PRESET_PATH,
    coreVersion: '1.5.1',
  });
  assert.equal(loaded.manifest.kind, 'aicommit-provider-presets');
  assert.equal(loaded.manifest.schemaVersion, 2);
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
      defaultModel: 'default',
      models: { default: { modelId: 'kimi-for-coding' } },
    },
  );

  const raw = JSON.parse(await readFile(BUNDLED_PROVIDER_PRESET_PATH, 'utf8'));
  assert.deepEqual(validateProviderPresetManifest(raw), loaded.manifest);
  assert.equal(assertProviderPresetCompatibility(raw, '1.99.0'), raw);
  assert.equal(assertProviderPresetCompatibility(raw, '1.5.2-beta.1'), raw);
  assert.equal(assertProviderPresetCompatibility(raw, '1.5.2-beta.1+build.7'), raw);
  assert.equal(assertProviderPresetCompatibility(raw, '2.0.0-rc.1'), raw);
  assert.throws(() => assertProviderPresetCompatibility(raw, '1.5.1-beta.1'), /requires aicommit/);
  assert.throws(
    () => assertProviderPresetCompatibility(raw, '1.5.2-beta.01'),
    /must be a semantic version/,
  );
  assert.equal(assertProviderPresetCompatibility(raw, '2.0.0'), raw);
  assert.throws(() => assertProviderPresetCompatibility(raw, '3.0.0'), /requires aicommit/);
});

test('preset validation rejects credentials, unsafe endpoints, dialect overrides, and bad contracts', async () => {
  const base = (
    await loadProviderPresetManifest({
      path: BUNDLED_PROVIDER_PRESET_PATH,
      coreVersion: '1.5.1',
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
  dialect.providers[0].models[dialect.providers[0].defaultModel].extraBody = {
    model: 'replacement',
  };
  assert.throws(() => validateProviderPresetManifest(dialect), /forbidden property: model/);

  const authorization = clone(base);
  authorization.providers[0].models[authorization.providers[0].defaultModel].extraBody = {
    nested: { authorization: 'secret' },
  };
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
