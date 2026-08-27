import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const readText = async (path) => (await readFile(path, 'utf8')).replaceAll('\r\n', '\n');

test('CI and npm release workflows run only for version tags', async () => {
  const ci = await readText(new URL('../.github/workflows/ci.yml', import.meta.url));
  const release = await readText(new URL('../.github/workflows/release.yml', import.meta.url));
  assert.match(ci, /push:\n    tags:\n      - 'v\*'/);
  assert.doesNotMatch(ci, /pull_request:|branches:/);
  assert.match(release, /push:\n    tags:\n      - 'v\*'/);
  assert.doesNotMatch(release, /workflow_dispatch:|release:\n    types:/);
  assert.match(release, /GITHUB_REF_NAME: \$\{\{ github\.ref_name \}\}/);
});

test('release workflow publishes one verified npm tarball with OIDC', async () => {
  const release = await readText(new URL('../.github/workflows/release.yml', import.meta.url));
  assert.match(release, /id-token: write/);
  assert.match(release, /PACK_FILENAME=\$\(npm pack --json/);
  assert.match(release, /PACKAGE_TARBALL=\.\/dist\/\$\{PACK_FILENAME\}/);
  assert.match(release, /npm publish "\$PACKAGE_TARBALL" --access public/);
  assert.doesNotMatch(
    release,
    /NODE_AUTH_TOKEN|NPM_TOKEN|actions\/attest|gh release upload|homebrew|brew |Formula/i,
  );
  assert.equal(manifest.publishConfig.provenance, true);
  assert.equal(manifest.name, '@hifullmoon/aicommit');
});

test('release, rollback, and verification docs remain executable', async () => {
  const distribution = await readText(new URL('../docs/distribution.md', import.meta.url));
  const releasing = await readText(new URL('../RELEASING.md', import.meta.url));
  assert.match(distribution, /npm audit signatures/);
  assert.match(distribution, /@hifullmoon\/aicommit@<last-good-version>/);
  assert.doesNotMatch(distribution, /homebrew|brew |Formula/i);
  assert.match(releasing, /git tag -a vX\.Y\.Z/);
  assert.match(releasing, /npm run release:version/);
  assert.doesNotMatch(releasing, /homebrew|brew |Formula/i);
});
