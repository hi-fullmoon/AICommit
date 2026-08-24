import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareReleaseAssets, renderHomebrewFormula } from '../scripts/release-assets.mjs';
import { validateSignedTagRecords } from '../scripts/verify-github-tag.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('release assets bind the npm tarball, Homebrew formula, SBOM, and checksums', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicommit-release-assets-'));
  try {
    const tarball = join(root, `aicommit-${manifest.version}.tgz`);
    const sbom = join(root, `aicommit-${manifest.version}.spdx.json`);
    await writeFile(tarball, 'deterministic tarball fixture');
    await writeFile(sbom, '{"spdxVersion":"SPDX-2.3"}\n');
    const result = await prepareReleaseAssets({ tarballPath: tarball, sbomPath: sbom });
    assert.equal(result.tarballSha256, hash('deterministic tarball fixture'));
    assert.equal(
      result.formulaUrl,
      `https://registry.npmjs.org/aicommit/-/aicommit-${manifest.version}.tgz`,
    );
    const formula = await readFile(result.formulaPath, 'utf8');
    assert.match(formula, /class Aicommit < Formula/);
    assert.match(formula, new RegExp(`version "${manifest.version.replaceAll('.', '\\.')}"`));
    assert.match(formula, new RegExp(result.tarballSha256));
    assert.match(formula, /system "npm", "install", \*std_npm_args/);
    assert.match(formula, /config validate --output=json/);
    const checksums = await readFile(result.checksumsPath, 'utf8');
    assert.match(checksums, new RegExp(`  aicommit-${manifest.version}\\.tgz`));
    assert.match(checksums, /  aicommit\.rb/);
    assert.match(checksums, new RegExp(`  aicommit-${manifest.version}\\.spdx\\.json`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('formula rendering rejects insecure or incomplete release coordinates', async () => {
  const valid = {
    version: '1.4.0',
    sha256: 'a'.repeat(64),
    url: 'https://registry.npmjs.org/aicommit/-/aicommit-1.4.0.tgz',
  };
  assert.match(await renderHomebrewFormula(valid), /sha256 "a{64}"/);
  await assert.rejects(
    () => renderHomebrewFormula({ ...valid, url: 'http://example.com/aicommit.tgz' }),
    /HTTPS/,
  );
  await assert.rejects(() => renderHomebrewFormula({ ...valid, sha256: 'not-a-hash' }), /sha256/);
});

test('release tag verifier requires an annotated, valid signature on the checked-out commit', () => {
  const commit = '1'.repeat(40);
  const tagSha = '2'.repeat(40);
  const reference = {
    ref: 'refs/tags/v1.4.0',
    object: { type: 'tag', sha: tagSha },
  };
  const tagObject = {
    sha: tagSha,
    tag: 'v1.4.0',
    object: { type: 'commit', sha: commit },
    verification: { verified: true, reason: 'valid' },
    tagger: { email: 'release@example.com' },
  };
  assert.deepEqual(
    validateSignedTagRecords(reference, tagObject, {
      expectedTag: 'v1.4.0',
      expectedCommit: commit,
    }),
    { tag: 'v1.4.0', commit, signer: 'release@example.com' },
  );
  assert.throws(
    () =>
      validateSignedTagRecords(
        { ...reference, object: { type: 'commit', sha: commit } },
        tagObject,
        { expectedTag: 'v1.4.0', expectedCommit: commit },
      ),
    /annotated tag/,
  );
  assert.throws(
    () =>
      validateSignedTagRecords(
        reference,
        { ...tagObject, verification: { verified: false, reason: 'unknown_key' } },
        { expectedTag: 'v1.4.0', expectedCommit: commit },
      ),
    /did not verify/,
  );
  assert.throws(
    () =>
      validateSignedTagRecords(reference, tagObject, {
        expectedTag: 'v1.4.0',
        expectedCommit: '3'.repeat(40),
      }),
    /checked-out commit/,
  );
});

test('release and CI workflows preserve signed npm and Homebrew distribution gates', async () => {
  const release = await readFile(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8',
  );
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(release, /verify-github-tag\.mjs/);
  assert.match(release, /uses: actions\/attest@v4/g);
  assert.match(release, /npm publish "dist\/aicommit-\$\{VERSION\}\.tgz" --provenance/);
  assert.match(release, /gh release upload/);
  assert.match(release, /brew install --formula Formula\/aicommit\.rb/);
  assert.match(ci, /homebrew-smoke:/);
  assert.match(ci, /AICOMMIT_HOMEBREW_SMOKE: '1'/);
  assert.equal(manifest.publishConfig.provenance, true);
});
