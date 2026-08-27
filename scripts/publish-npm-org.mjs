import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const DIST_TAG = /^[a-z0-9][a-z0-9._-]*$/;

function commandText(file, args) {
  return [file, ...args].join(' ');
}

function captured(file, args, { allowFailure = false } = {}) {
  const result = spawnSync(file, args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    const details = `${result.stdout || ''}${result.stderr || ''}`.trim();
    throw new Error(`${commandText(file, args)} failed${details ? `:\n${details}` : '.'}`);
  }
  return result;
}

function live(file, args) {
  const result = spawnSync(file, args, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${commandText(file, args)} failed.`);
}

function parseJson(output, label) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

export function scopedPackage(name) {
  const match = /^@([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/.exec(name || '');
  if (!match) throw new Error('package.json name must use the @organization/package form.');
  return { organization: match[1], packageName: match[2] };
}

export function assertOrgMembership(members, username, organization) {
  if (!members || typeof members !== 'object' || Array.isArray(members)) {
    throw new Error(`npm returned an invalid member list for @${organization}.`);
  }
  if (!Object.hasOwn(members, username)) {
    throw new Error(`npm user ${username} is not a member of @${organization}.`);
  }
  return members[username];
}

function isNotFound(result) {
  return result.status !== 0 && /(?:\bE404\b|404 Not Found)/i.test(result.stderr || '');
}

function npmView(spec, field) {
  const result = captured(NPM, ['view', spec, field, '--json'], { allowFailure: true });
  if (isNotFound(result)) return null;
  if (result.status !== 0) {
    const details = `${result.stdout || ''}${result.stderr || ''}`.trim();
    throw new Error(`Could not query ${spec} from npm${details ? `:\n${details}` : '.'}`);
  }
  return parseJson(result.stdout, `npm view ${spec}`);
}

function verifyGitReleaseSource() {
  const status = captured('git', ['status', '--porcelain=v1', '--untracked-files=all']).stdout;
  if (status.trim()) {
    throw new Error(
      'Refusing to publish from a dirty Git worktree. Commit or stash every change first.',
    );
  }
  const branch = captured('git', ['branch', '--show-current']).stdout.trim();
  if (branch !== 'main')
    throw new Error(`Refusing to publish from branch ${branch || '(detached)'}.`);
  const local = captured('git', ['rev-parse', 'HEAD']).stdout.trim();
  const remoteResult = captured('git', ['rev-parse', 'origin/main'], { allowFailure: true });
  if (remoteResult.status !== 0 || remoteResult.stdout.trim() !== local) {
    throw new Error('Refusing to publish because HEAD does not exactly match origin/main.');
  }
}

function verifyManifest(manifest) {
  const coordinates = scopedPackage(manifest.name);
  if (manifest.private === true) throw new Error('package.json is marked private.');
  if (manifest.publishConfig?.access !== 'public') {
    throw new Error('publishConfig.access must be public for this organization package.');
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version || '')) {
    throw new Error('package.json version must be semantic.');
  }
  return coordinates;
}

function verifyNpmIdentity(organization) {
  const whoami = captured(NPM, ['whoami'], { allowFailure: true });
  if (whoami.status !== 0) {
    throw new Error('npm is not logged in. Run `npm login`, then retry.');
  }
  const username = whoami.stdout.trim();
  const listing = captured(NPM, ['org', 'ls', organization, '--json'], { allowFailure: true });
  if (listing.status !== 0) {
    if (isNotFound(listing)) {
      throw new Error(
        `npm organization @${organization} does not exist or is not visible to ${username}. Create/join it on npmjs.com, then retry.`,
      );
    }
    const details = `${listing.stdout || ''}${listing.stderr || ''}`.trim();
    throw new Error(`Could not read @${organization} membership${details ? `:\n${details}` : '.'}`);
  }
  const role = assertOrgMembership(
    parseJson(listing.stdout, `npm org ls ${organization}`),
    username,
    organization,
  );
  process.stdout.write(`npm identity: ${username} (${role} in @${organization})\n`);
}

function runReleaseGates() {
  for (const [file, args] of [
    [NPM, ['ci']],
    [NPM, ['run', 'ci']],
    [NPM, ['run', 'test:package']],
    [NPM, ['audit', '--omit=dev']],
  ]) {
    process.stdout.write(`\n> ${commandText(file, args)}\n`);
    live(file, args);
  }
}

function pack(outputDirectory, manifest) {
  const result = captured(NPM, ['pack', '--json', '--pack-destination', outputDirectory]);
  const records = parseJson(result.stdout, 'npm pack');
  if (!Array.isArray(records) || records.length !== 1) {
    throw new Error('npm pack must produce exactly one tarball.');
  }
  const [record] = records;
  if (record.name !== manifest.name || record.version !== manifest.version) {
    throw new Error('npm pack metadata does not match package.json name/version.');
  }
  const tarball = join(outputDirectory, record.filename);
  if (!existsSync(tarball)) throw new Error(`npm pack did not create ${tarball}.`);
  return tarball;
}

async function waitForPublishedVersion(spec, expected) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const version = npmView(spec, 'version');
    if (version === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`npm accepted the publish, but ${spec} is not visible in the registry yet.`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      publish: { type: 'boolean', default: false },
      tag: { type: 'string', default: 'latest' },
    },
    strict: true,
  });
  if (!DIST_TAG.test(values.tag)) throw new Error(`Invalid npm dist-tag: ${values.tag}`);

  const manifest = parseJson(
    await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8'),
    'package.json',
  );
  const { organization } = verifyManifest(manifest);
  const spec = `${manifest.name}@${manifest.version}`;
  const packageExists = npmView(manifest.name, 'name') !== null;
  const publishedVersion = npmView(spec, 'version');
  if (publishedVersion !== null)
    throw new Error(`${spec} is already published and cannot be reused.`);

  if (values.publish) {
    if (packageExists) {
      throw new Error(
        `${manifest.name} already exists. Publish subsequent versions through the signed GitHub Release workflow, not this bootstrap script.`,
      );
    }
    verifyNpmIdentity(organization);
    process.stdout.write('\n> git fetch --quiet origin main\n');
    live('git', ['fetch', '--quiet', 'origin', 'main']);
    verifyGitReleaseSource();
  }

  runReleaseGates();
  const staging = await mkdtemp(join(tmpdir(), 'aicommit-npm-publish-'));
  try {
    const tarball = pack(staging, manifest);
    const publishArgs = [
      'publish',
      tarball,
      '--access',
      'public',
      '--tag',
      values.tag,
      '--provenance=false',
    ];
    if (!values.publish) publishArgs.push('--dry-run');
    if (values.publish) verifyGitReleaseSource();
    process.stdout.write(`\n> ${commandText(NPM, publishArgs)}\n`);
    live(NPM, publishArgs);
    if (!values.publish) {
      process.stdout.write(`\nDry run passed for ${spec}. Nothing was published.\n`);
      return;
    }
    await waitForPublishedVersion(spec, manifest.version);
    process.stdout.write(`\nPublished ${spec} with dist-tag ${values.tag}.\n`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`npm organization publish failed: ${error.message}`);
    process.exitCode = 1;
  });
}
