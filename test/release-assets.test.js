import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  npmPackageCoordinates,
  prepareReleaseAssets,
  renderHomebrewFormula,
} from '../scripts/release-assets.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('release assets bind the npm tarball and Homebrew formula', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicommit-release-assets-'));
  try {
    const tarball = join(root, `hifullmoon-aicommit-${manifest.version}.tgz`);
    await writeFile(tarball, 'deterministic tarball fixture');
    const result = await prepareReleaseAssets({ tarballPath: tarball });
    assert.equal(result.tarballSha256, hash('deterministic tarball fixture'));
    assert.equal(
      result.formulaUrl,
      `https://registry.npmjs.org/@hifullmoon/aicommit/-/aicommit-${manifest.version}.tgz`,
    );
    const formula = await readFile(result.formulaPath, 'utf8');
    assert.match(formula, /class Aicommit < Formula/);
    assert.match(formula, new RegExp(`version "${manifest.version.replaceAll('.', '\\.')}"`));
    assert.match(formula, new RegExp(result.tarballSha256));
    assert.match(formula, /system "npm", "install", \*std_npm_args/);
    assert.match(formula, /config validate --output=json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('formula rendering rejects insecure or incomplete release coordinates', async () => {
  const valid = {
    version: '1.4.0',
    sha256: 'a'.repeat(64),
    url: 'https://registry.npmjs.org/@hifullmoon/aicommit/-/aicommit-1.4.0.tgz',
  };
  assert.match(await renderHomebrewFormula(valid), /sha256 "a{64}"/);
  await assert.rejects(
    () => renderHomebrewFormula({ ...valid, url: 'http://example.com/aicommit.tgz' }),
    /HTTPS/,
  );
  await assert.rejects(() => renderHomebrewFormula({ ...valid, sha256: 'not-a-hash' }), /sha256/);
});

test('npm coordinates keep the scoped registry identity and canonical assets', () => {
  assert.deepEqual(npmPackageCoordinates('@hifullmoon/aicommit', '1.4.0'), {
    scope: 'hifullmoon',
    packageName: 'aicommit',
    canonicalTarballName: 'aicommit-1.4.0.tgz',
    packedTarballName: 'hifullmoon-aicommit-1.4.0.tgz',
    registryUrl: 'https://registry.npmjs.org/@hifullmoon/aicommit/-/aicommit-1.4.0.tgz',
  });
  assert.throws(() => npmPackageCoordinates('aicommit', '1.4.0'), /scoped npm package/);
});

test('release workflow preserves npm OIDC and Homebrew distribution gates', async () => {
  const release = await readFile(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8',
  );
  assert.match(release, /id-token: write/);
  assert.match(release, /npm publish "dist\/aicommit-\$\{VERSION\}\.tgz" --access public/);
  assert.match(release, /PACK_FILENAME=\$\(npm pack --json/);
  assert.match(release, /cmp dist\/aicommit\.rb Formula\/aicommit\.rb/);
  assert.match(release, /brew install --formula aicommit-ci\/release\/aicommit/);
  assert.doesNotMatch(release, /NODE_AUTH_TOKEN|NPM_TOKEN|actions\/attest|gh release upload/);
  assert.equal(manifest.publishConfig.provenance, true);
  assert.equal(manifest.name, '@hifullmoon/aicommit');
});

test('release, rollback, verification, and preset compatibility docs remain executable', async () => {
  const distribution = await readFile(new URL('../docs/distribution.md', import.meta.url), 'utf8');
  const presets = await readFile(new URL('../docs/provider-presets.md', import.meta.url), 'utf8');
  const releasing = await readFile(new URL('../RELEASING.md', import.meta.url), 'utf8');
  assert.match(distribution, /npm audit signatures/);
  assert.match(distribution, /brew upgrade hi-fullmoon\/aicommit\/aicommit/);
  assert.match(distribution, /brew install --formula \/tmp\/aicommit\.rb/);
  assert.match(presets, /"coreMinimum": "1\.4\.0"/);
  assert.match(presets, /aicommit preset rollback/);
  assert.match(releasing, /git tag -a vX\.Y\.Z/);
  assert.match(releasing, /AICOMMIT_HOMEBREW_SMOKE=1/);
});
