import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_COMMIT_POLICY } from '../src/policy.js';
import { getSplitStateFingerprint, getStagedChangedFiles } from '../src/split.js';
import { splitCheckpointPath } from '../src/split-checkpoint.js';
import { createSplitPlanArtifact, writeSplitPlanArtifact } from '../src/split-plan.js';

const CLI = fileURLToPath(new URL('../bin/aicommit.js', import.meta.url));

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function makeRepo(root, name = 'repo') {
  const repo = join(root, name);
  mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  return repo;
}

function runCli(cwd, home, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
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

async function writeStagedPlan(repo, planPath, groups) {
  const changes = getStagedChangedFiles(repo);
  const baseHead = git(repo, ['rev-parse', 'HEAD']).trim();
  const artifact = createSplitPlanArtifact({
    scope: 'staged',
    baseHead,
    fingerprint: getSplitStateFingerprint(repo, true, changes, 'staged'),
    language: 'en',
    commitPolicy: DEFAULT_COMMIT_POLICY,
    changes,
    groups,
  });
  await writeSplitPlanArtifact(planPath, artifact);
  return artifact;
}

function prepareTwoFileRepo(root, name) {
  const repo = makeRepo(root, name);
  writeFileSync(join(repo, 'a.txt'), 'base a\n');
  writeFileSync(join(repo, 'b.txt'), 'base b\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'init']);
  writeFileSync(join(repo, 'a.txt'), 'next a\n');
  writeFileSync(join(repo, 'b.txt'), 'next b\n');
  git(repo, ['add', '.']);
  return repo;
}

test('fault matrix resumes SIGINT and post-commit crash windows without duplicates', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-split-signals-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const scenarios = [
    {
      name: 'ctrl-c before commit',
      injection: 'after_checkpoint_before_commit:SIGINT',
      commitsAfterFault: '1',
    },
    {
      name: 'crash after commit',
      injection: 'after_commit_before_checkpoint:SIGKILL',
      commitsAfterFault: '2',
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    await t.test(scenario.name, async () => {
      const repo = prepareTwoFileRepo(root, `repo-${index}`);
      const planPath = join(root, `signal-${index}.json`);
      await writeStagedPlan(repo, planPath, [
        { message: 'fix: commit a snapshot', files: ['a.txt'] },
        { message: 'feat: commit b snapshot', files: ['b.txt'] },
      ]);

      const interrupted = await runCli(
        repo,
        home,
        ['split', 'apply', `--file=${planPath}`, '--yes'],
        {
          NODE_ENV: 'test',
          AICOMMIT_TEST_SPLIT_FAULT: scenario.injection,
        },
      );
      assert.notEqual(interrupted.code, 0, interrupted.stdout + interrupted.stderr);
      assert.equal(git(repo, ['rev-list', '--count', 'HEAD']).trim(), scenario.commitsAfterFault);
      assert.equal(existsSync(splitCheckpointPath(repo)), true);

      const resumed = await runCli(repo, home, ['split', 'resume', '--yes']);
      assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
      assert.equal(
        git(repo, ['log', '--reverse', '--format=%s']).trim(),
        'init\nfix: commit a snapshot\nfeat: commit b snapshot',
      );
      assert.equal(git(repo, ['status', '--porcelain']), '');
      assert.equal(existsSync(splitCheckpointPath(repo)), false);
    });
  }
});

test('fault matrix rejects a concurrent pending edit and resumes after exact restoration', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-split-concurrent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = prepareTwoFileRepo(root, 'repo');
  const planPath = join(root, 'concurrent.json');
  await writeStagedPlan(repo, planPath, [
    { message: 'fix: commit a before interruption', files: ['a.txt'] },
    { message: 'feat: commit b after interruption', files: ['b.txt'] },
  ]);
  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  writeFileSync(
    hook,
    '#!/bin/sh\nif test "$(git diff --cached --name-only)" = "b.txt"; then exit 1; fi\n',
  );
  chmodSync(hook, 0o755);

  const interrupted = await runCli(repo, home, ['split', 'apply', `--file=${planPath}`, '--yes']);
  assert.equal(interrupted.code, 3, interrupted.stdout + interrupted.stderr);
  rmSync(hook);
  writeFileSync(join(repo, 'b.txt'), 'concurrent b edit\n');
  git(repo, ['add', 'b.txt']);
  const rejected = await runCli(repo, home, ['split', 'resume', '--yes']);
  assert.equal(rejected.code, 8, rejected.stdout + rejected.stderr);
  assert.match(rejected.stderr, /content changed after interruption/);
  assert.equal(git(repo, ['rev-list', '--count', 'HEAD']).trim(), '2');
  assert.equal(existsSync(splitCheckpointPath(repo)), true);

  writeFileSync(join(repo, 'b.txt'), 'next b\n');
  git(repo, ['add', 'b.txt']);
  const resumed = await runCli(repo, home, ['split', 'resume', '--yes']);
  assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
  assert.equal(
    git(repo, ['log', '--reverse', '--format=%s']).trim(),
    'init\nfix: commit a before interruption\nfeat: commit b after interruption',
  );
  assert.equal(git(repo, ['status', '--porcelain']), '');
});

test('split abort clears stale recovery metadata without rewriting replacement work', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-split-abort-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = prepareTwoFileRepo(root, 'repo');
  const planPath = join(root, 'abort.json');
  await writeStagedPlan(repo, planPath, [
    { message: 'fix: commit a snapshot', files: ['a.txt'] },
    { message: 'feat: commit b snapshot', files: ['b.txt'] },
  ]);

  const interrupted = await runCli(repo, home, ['split', 'apply', `--file=${planPath}`, '--yes'], {
    NODE_ENV: 'test',
    AICOMMIT_TEST_SPLIT_FAULT: 'after_checkpoint_before_commit:SIGINT',
  });
  assert.notEqual(interrupted.code, 0, interrupted.stdout + interrupted.stderr);
  assert.equal(existsSync(splitCheckpointPath(repo)), true);

  git(repo, ['commit', '-qm', 'chore: replace interrupted split']);
  const headBefore = git(repo, ['rev-parse', 'HEAD']);
  const statusBefore = git(repo, ['status', '--porcelain']);
  const aborted = await runCli(repo, home, ['split', 'abort', '--yes', '--output=json']);
  assert.equal(aborted.code, 0, aborted.stdout + aborted.stderr);
  const output = JSON.parse(aborted.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.exitReason, 'split_aborted');
  assert.equal(output.data.checkpointRemoved, true);
  assert.equal(existsSync(splitCheckpointPath(repo)), false);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(git(repo, ['status', '--porcelain']), statusBefore);
});

test('fault matrix preserves rename, deletion, and binary groups through plan/apply', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-split-file-kinds-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  writeFileSync(join(repo, 'old.txt'), 'rename me\n');
  writeFileSync(join(repo, 'deleted.txt'), 'delete me\n');
  writeFileSync(join(repo, 'asset.bin'), Buffer.from([0, 1, 2, 3]));
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'init']);
  git(repo, ['mv', 'old.txt', 'new.txt']);
  rmSync(join(repo, 'deleted.txt'));
  writeFileSync(join(repo, 'asset.bin'), Buffer.from([0, 9, 2, 3, 4]));
  git(repo, ['add', '-A']);
  const planPath = join(root, 'file-kinds.json');

  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify([
                  { subject: 'refactor: rename text file', files: ['old.txt → new.txt'] },
                  { subject: 'chore: remove deleted file', files: ['deleted.txt'] },
                  { subject: 'fix: update binary asset', files: ['asset.bin'] },
                ]),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const configPath = join(home, '.aicommit.config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      apiKey: '',
      modelId: 'local-test-model',
      language: 'en',
      reasoning: { mode: 'off' },
    }),
  );
  const planned = await runCli(repo, home, [
    'split',
    'plan',
    '--scope=staged',
    `--file=${planPath}`,
    '--yes',
    '--no-reasoning',
  ]);
  assert.equal(planned.code, 0, planned.stdout + planned.stderr);
  rmSync(configPath);
  const applied = await runCli(repo, home, ['split', 'apply', `--file=${planPath}`, '--yes']);
  assert.equal(applied.code, 0, applied.stdout + applied.stderr);
  assert.equal(git(repo, ['rev-list', '--count', 'HEAD']).trim(), '4');
  assert.equal(git(repo, ['show', 'HEAD~2:new.txt']), 'rename me\n');
  assert.equal(git(repo, ['ls-tree', 'HEAD~1', '--', 'deleted.txt']), '');
  assert.deepEqual(
    execFileSync('git', ['show', 'HEAD:asset.bin'], { cwd: repo }),
    Buffer.from([0, 9, 2, 3, 4]),
  );
  assert.equal(git(repo, ['status', '--porcelain']), '');
});

test('fault matrix rejects a changed submodule before the first commit and preserves the index', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-split-submodule-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  writeFileSync(join(repo, 'root.txt'), 'base\n');
  git(repo, ['add', 'root.txt']);
  git(repo, ['commit', '-qm', 'init']);
  const head = git(repo, ['rev-parse', 'HEAD']).trim();
  git(repo, ['update-index', '--add', '--cacheinfo', `160000,${head},vendor/sub`]);
  const planPath = join(root, 'submodule.json');
  await writeStagedPlan(repo, planPath, [
    { message: 'chore: update submodule pointer', files: ['vendor/sub'] },
  ]);
  const indexBefore = readFileSync(join(repo, '.git', 'index'));

  const applied = await runCli(repo, home, ['split', 'apply', `--file=${planPath}`, '--yes']);
  assert.equal(applied.code, 3, applied.stdout + applied.stderr);
  assert.match(applied.stderr, /does not support submodule/);
  assert.equal(git(repo, ['rev-list', '--count', 'HEAD']).trim(), '1');
  assert.deepEqual(readFileSync(join(repo, '.git', 'index')), indexBefore);
  assert.equal(existsSync(splitCheckpointPath(repo)), false);
});
