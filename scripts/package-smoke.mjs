import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NPM_CLI = process.env.npm_execpath;

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function npm(args, options = {}) {
  if (NPM_CLI) return run(process.execPath, [NPM_CLI, ...args], options);
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options);
}

function git(cwd, args) {
  return run('git', args, { cwd });
}

function makeRepo(root) {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'package-smoke@example.com']);
  git(repo, ['config', 'user.name', 'Package Smoke']);
  writeFileSync(join(repo, 'app.js'), 'export const value = 1;\n');
  git(repo, ['add', 'app.js']);
  git(repo, ['commit', '-qm', 'init']);
  writeFileSync(join(repo, 'app.js'), 'export const value = 2;\n');
  git(repo, ['add', 'app.js']);
  return repo;
}

function installedCli(prefix) {
  const binLink =
    process.platform === 'win32' ? join(prefix, 'aicommit.cmd') : join(prefix, 'bin', 'aicommit');
  assert.ok(existsSync(binLink), `npm did not create the aicommit bin link at ${binLink}`);

  const entry =
    process.platform === 'win32'
      ? join(prefix, 'node_modules', 'aicommit', 'bin', 'aicommit.js')
      : realpathSync(binLink);
  assert.ok(existsSync(entry), `installed CLI entry is missing at ${entry}`);
  return entry;
}

function runCli(entry, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-package-smoke-'));
  let server;
  try {
    const packResult = JSON.parse(
      npm(['pack', '--json', '--pack-destination', root], { cwd: PROJECT_ROOT }),
    );
    assert.equal(packResult.length, 1, 'npm pack should produce exactly one tarball');
    const tarball = join(root, packResult[0].filename);
    assert.ok(existsSync(tarball), `npm pack did not create ${tarball}`);
    const packedPaths = new Set(packResult[0].files.map((file) => file.path));
    for (const expected of [
      '.aicommit.config.example.json',
      'CHANGELOG.md',
      'LICENSE',
      'README.md',
      'SECURITY.md',
      'bin/aicommit.js',
      'package.json',
      'src/main.js',
    ]) {
      assert.ok(packedPaths.has(expected), `published package is missing ${expected}`);
    }
    for (const path of packedPaths) {
      assert.doesNotMatch(path, /^(?:\.github|coverage|scripts|test)\//);
    }

    const prefix = join(root, 'global');
    npm(
      [
        'install',
        '--global',
        '--prefix',
        prefix,
        '--registry=https://registry.npmjs.org/',
        '--prefer-offline',
        '--fetch-retries=2',
        '--fetch-timeout=30000',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        tarball,
      ],
      { cwd: root },
    );
    const entry = installedCli(prefix);
    const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8'));

    assert.match(run(process.execPath, [entry, '--help']), /Usage:/);
    assert.equal(
      run(process.execPath, [entry, '--version']).trim(),
      `aicommit v${manifest.version}`,
    );

    const home = join(root, 'home');
    mkdirSync(home);
    const repo = makeRepo(root);
    server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            choices: [{ message: { content: 'test: verify installed package dry run' } }],
          }),
        );
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    writeFileSync(
      join(home, '.aicommit.config.json'),
      JSON.stringify({
        apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
        apiKey: '',
        modelId: 'package-smoke-model',
        reasoning: { mode: 'off' },
      }),
    );

    const result = await runCli(entry, ['--yes', '--dry-run', '--no-reasoning'], {
      cwd: repo,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
    });
    assert.equal(result.signal, null);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Dry run complete/);
    assert.equal(git(repo, ['log', '-1', '--pretty=%s']).trim(), 'init');
    assert.match(git(repo, ['diff', '--staged']), /value = 2/);

    console.log(`Package smoke passed: ${packResult[0].filename}`);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
