import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  compareVersions,
  resolveVersion,
  updateChangelog,
  updateVersion,
} from '../scripts/update-version.mjs';

test('version bumps accept release types and explicit SemVer versions', () => {
  assert.equal(resolveVersion('1.5.1', 'patch'), '1.5.2');
  assert.equal(resolveVersion('1.5.1', 'minor'), '1.6.0');
  assert.equal(resolveVersion('1.5.1', 'major'), '2.0.0');
  assert.equal(resolveVersion('1.5.1', '1.6.0-beta.1'), '1.6.0-beta.1');
  assert.throws(() => resolveVersion('1.5.1', '1.5.1'), /must be greater/);
  assert.throws(() => resolveVersion('1.5.1', 'v1.5.2'), /Invalid semantic version/);
});

test('version comparison follows SemVer prerelease ordering', () => {
  assert.ok(compareVersions('1.6.0-beta.2', '1.6.0-beta.1') > 0);
  assert.ok(compareVersions('1.6.0-beta.10', '1.6.0-beta.2') > 0);
  assert.ok(compareVersions('1.6.0', '1.6.0-beta.10') > 0);
});

test('changelog promotion moves Unreleased notes and comparison links', () => {
  const changelog = `# Changelog

## [Unreleased]

### Added

- New release automation.

## [1.5.1] - 2026-08-27

- Previous release.

[Unreleased]: https://github.com/hi-fullmoon/AICommit/compare/v1.5.1...HEAD
[1.5.1]: https://github.com/hi-fullmoon/AICommit/releases/tag/v1.5.1
`;
  const updated = updateChangelog(changelog, '1.5.1', '1.6.0', new Date(2026, 7, 28));
  assert.match(updated, /## \[Unreleased\]\n\n## \[1\.6\.0\] - 2026-08-28/);
  assert.match(updated, /## \[1\.6\.0\][\s\S]*### Added[\s\S]*New release automation/);
  assert.match(updated, /New release automation\.\n\n## \[1\.5\.1\]/);
  assert.match(updated, /compare\/v1\.6\.0\.\.\.HEAD/);
  assert.match(updated, /\[1\.6\.0\]: .*\/releases\/tag\/v1\.6\.0/);
});

test('changelog promotion requires release notes', () => {
  const changelog = `# Changelog

## [Unreleased]

## [1.5.1] - 2026-08-27

[Unreleased]: https://github.com/hi-fullmoon/AICommit/compare/v1.5.1...HEAD
`;
  assert.throws(
    () => updateChangelog(changelog, '1.5.1', '1.5.2', new Date(2026, 7, 28)),
    /Add release notes/,
  );
});

test('version update synchronizes npm metadata and docs without release-channel assets', async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'aicommit-update-version-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(join(projectRoot, 'docs'));
  await writeFile(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ name: '@hifullmoon/aicommit', version: '1.5.1' }, null, 2)}\n`,
  );
  await writeFile(
    join(projectRoot, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: '@hifullmoon/aicommit',
        version: '1.5.1',
        lockfileVersion: 3,
        packages: { '': { name: '@hifullmoon/aicommit', version: '1.5.1' } },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(projectRoot, 'CHANGELOG.md'),
    `# Changelog

## [Unreleased]

### Changed

- Publish through npm only.

## [1.5.1] - 2026-08-27

[Unreleased]: https://github.com/hi-fullmoon/AICommit/compare/v1.5.1...HEAD
[1.5.1]: https://github.com/hi-fullmoon/AICommit/releases/tag/v1.5.1
`,
  );
  await writeFile(
    join(projectRoot, 'docs', 'distribution.md'),
    'npm install --package-lock-only @hifullmoon/aicommit@1.5.1\n',
  );

  assert.deepEqual(await updateVersion('patch', { projectRoot }), {
    currentVersion: '1.5.1',
    nextVersion: '1.5.2',
  });
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const lockfile = JSON.parse(await readFile(join(projectRoot, 'package-lock.json'), 'utf8'));
  const changelog = await readFile(join(projectRoot, 'CHANGELOG.md'), 'utf8');
  const distribution = await readFile(join(projectRoot, 'docs', 'distribution.md'), 'utf8');
  assert.equal(manifest.version, '1.5.2');
  assert.equal(lockfile.version, '1.5.2');
  assert.equal(lockfile.packages[''].version, '1.5.2');
  assert.match(changelog, /## \[1\.5\.2\]/);
  assert.match(distribution, /@hifullmoon\/aicommit@1\.5\.2/);
});
