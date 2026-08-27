import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseVersion(version) {
  const match = SEMVER.exec(version || '');
  if (!match) {
    throw new Error(`Invalid semantic version: ${version || '(empty)'}`);
  }
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

export function resolveVersion(currentVersion, requestedVersion) {
  const current = parseVersion(currentVersion);
  let nextVersion;
  switch (requestedVersion) {
    case 'major':
      nextVersion = `${current.major + 1}.0.0`;
      break;
    case 'minor':
      nextVersion = `${current.major}.${current.minor + 1}.0`;
      break;
    case 'patch':
      nextVersion = `${current.major}.${current.minor}.${current.patch + 1}`;
      break;
    default:
      parseVersion(requestedVersion);
      nextVersion = requestedVersion;
  }
  if (compareVersions(nextVersion, currentVersion) <= 0) {
    throw new Error(
      `New version ${nextVersion} must be greater than current version ${currentVersion}.`,
    );
  }
  return nextVersion;
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function updateChangelog(contents, currentVersion, nextVersion, date = new Date()) {
  const unreleasedHeader = '## [Unreleased]';
  const headerIndex = contents.indexOf(unreleasedHeader);
  if (headerIndex === -1 || contents.indexOf(unreleasedHeader, headerIndex + 1) !== -1) {
    throw new Error('CHANGELOG.md must contain exactly one "## [Unreleased]" section.');
  }
  if (contents.includes(`## [${nextVersion}]`) || contents.includes(`## ${nextVersion}`)) {
    throw new Error(`CHANGELOG.md already contains version ${nextVersion}.`);
  }
  const bodyStart = headerIndex + unreleasedHeader.length;
  const nextSection = contents.indexOf('\n## ', bodyStart);
  const bodyEnd = nextSection === -1 ? contents.length : nextSection;
  const releaseNotes = contents.slice(bodyStart, bodyEnd).trim();
  if (!releaseNotes) {
    throw new Error('Add release notes under "## [Unreleased]" before updating the version.');
  }

  const remainingSections = contents.slice(bodyEnd).replace(/^\n+/, '');
  let updated = `${contents.slice(0, bodyStart)}\n\n## [${nextVersion}] - ${formatDate(date)}\n\n${releaseNotes}\n\n${remainingSections}`;
  const oldCompare = `[Unreleased]: https://github.com/hi-fullmoon/AICommit/compare/v${currentVersion}...HEAD`;
  const newCompare = `[Unreleased]: https://github.com/hi-fullmoon/AICommit/compare/v${nextVersion}...HEAD`;
  if (!updated.includes(oldCompare)) {
    throw new Error(`CHANGELOG.md is missing the expected comparison link for v${currentVersion}.`);
  }
  updated = updated.replace(
    oldCompare,
    `${newCompare}\n[${nextVersion}]: https://github.com/hi-fullmoon/AICommit/releases/tag/v${nextVersion}`,
  );
  return updated;
}

function updateLockfile(lockfile, currentVersion, nextVersion) {
  if (lockfile.version !== currentVersion || lockfile.packages?.['']?.version !== currentVersion) {
    throw new Error(`package-lock.json version must match package.json version ${currentVersion}.`);
  }
  lockfile.version = nextVersion;
  lockfile.packages[''].version = nextVersion;
}

function updateDistributionDocs(contents, currentVersion, nextVersion) {
  const currentReference = `@hifullmoon/aicommit@${currentVersion}`;
  if (!contents.includes(currentReference)) {
    throw new Error(`docs/distribution.md is missing ${currentReference}.`);
  }
  return contents.replaceAll(currentReference, `@hifullmoon/aicommit@${nextVersion}`);
}

async function readVersionFiles(projectRoot) {
  const paths = {
    manifest: join(projectRoot, 'package.json'),
    lockfile: join(projectRoot, 'package-lock.json'),
    changelog: join(projectRoot, 'CHANGELOG.md'),
    distribution: join(projectRoot, 'docs', 'distribution.md'),
  };
  const originals = new Map();
  for (const path of Object.values(paths)) originals.set(path, await readFile(path, 'utf8'));
  return { paths, originals };
}

async function restoreFiles(originals) {
  await Promise.all([...originals].map(([path, contents]) => writeFile(path, contents, 'utf8')));
}

export async function updateVersion(requestedVersion, { projectRoot = PROJECT_ROOT } = {}) {
  if (!requestedVersion) {
    throw new Error('Usage: npm run release:version -- <patch|minor|major|X.Y.Z>');
  }
  const { paths, originals } = await readVersionFiles(projectRoot);
  const manifest = JSON.parse(originals.get(paths.manifest));
  const lockfile = JSON.parse(originals.get(paths.lockfile));
  const currentVersion = manifest.version;
  const nextVersion = resolveVersion(currentVersion, requestedVersion);

  manifest.version = nextVersion;
  updateLockfile(lockfile, currentVersion, nextVersion);
  const changelog = updateChangelog(originals.get(paths.changelog), currentVersion, nextVersion);
  const distribution = updateDistributionDocs(
    originals.get(paths.distribution),
    currentVersion,
    nextVersion,
  );

  try {
    await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await writeFile(paths.lockfile, `${JSON.stringify(lockfile, null, 2)}\n`, 'utf8');
    await writeFile(paths.changelog, changelog, 'utf8');
    await writeFile(paths.distribution, distribution, 'utf8');
    return { currentVersion, nextVersion };
  } catch (error) {
    await restoreFiles(originals);
    throw error;
  }
}

async function main() {
  const result = await updateVersion(process.argv[2]);
  console.log(`Updated AICommit ${result.currentVersion} -> ${result.nextVersion}.`);
  console.log(`After reviewing and committing the changes, push tag v${result.nextVersion}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
