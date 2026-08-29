import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_COMMIT_POLICY } from '../src/policy.js';
import { createSplitPlanArtifact } from '../src/split-plan.js';
import {
  discoverSplitHunks,
  fallbackHunkGroups,
  stripHunkCatalog,
  validateHunkTransaction,
} from '../src/split-hunks.js';
import { executeSplit, getSplitStateFingerprint, resumeSplit } from '../src/split.js';

function git(repo, args, input) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', input });
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'aicommit-hunks-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  return repo;
}

function targetSnapshot(repo, path) {
  const oid = git(repo, ['hash-object', '-w', '--', path]).trim();
  const index = git(repo, ['ls-files', '--stage', '--', path]).trim().split(/\s+/);
  return {
    path,
    target: { mode: index[0], oid },
    index: { mode: index[0], oid: index[1] },
  };
}

test('experimental hunk transaction uses temporary patches and reconstructs the target losslessly', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const path = 'app.txt';
  const original = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  writeFileSync(join(repo, path), original.join('\n') + '\n');
  git(repo, ['add', path]);
  git(repo, ['commit', '-qm', 'init']);
  const changed = [...original];
  changed[1] = 'first logical change';
  changed[25] = 'second logical change';
  writeFileSync(join(repo, path), changed.join('\n') + '\n');

  const baseHead = git(repo, ['rev-parse', 'HEAD']).trim();
  const snapshots = [targetSnapshot(repo, path)];
  const changes = discoverSplitHunks(
    repo,
    baseHead,
    [{ status: 'M', path, addPaths: [path] }],
    snapshots,
  );
  assert.deepEqual(
    changes[0].hunks.map((hunk) => hunk.id),
    ['H1', 'H2'],
  );
  const groups = [
    { message: 'fix: apply first hunk', files: [], hunks: [{ path, ids: ['H1'] }] },
    { message: 'feat: apply second hunk', files: [], hunks: [{ path, ids: ['H2'] }] },
  ];
  const plan = createSplitPlanArtifact({
    scope: 'all',
    baseHead,
    fingerprint: getSplitStateFingerprint(repo, true, changes, 'all'),
    language: 'en',
    commitPolicy: DEFAULT_COMMIT_POLICY,
    changes,
    groups,
    hunkMode: true,
  });
  const indexBefore = readFileSync(join(repo, '.git', 'index'));
  const validation = validateHunkTransaction(repo, plan, snapshots);
  assert.equal(validation.groupTrees.length, 2);
  assert.deepEqual(readFileSync(join(repo, '.git', 'index')), indexBefore);
  assert.equal(readFileSync(join(repo, path), 'utf8'), changed.join('\n') + '\n');

  assert.equal(executeSplit(groups, repo, changes, false, 'all', { planArtifact: plan }), true);
  const firstCommit = git(repo, ['show', 'HEAD~1:app.txt']);
  assert.match(firstCommit, /first logical change/);
  assert.doesNotMatch(firstCommit, /second logical change/);
  assert.equal(git(repo, ['show', 'HEAD:app.txt']), changed.join('\n') + '\n');
  assert.equal(git(repo, ['status', '--porcelain']), '');
});

test('tampered hunk metadata fails closed and has a deterministic file-level fallback', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const path = 'app.txt';
  const original = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`);
  writeFileSync(join(repo, path), original.join('\n') + '\n');
  git(repo, ['add', path]);
  git(repo, ['commit', '-qm', 'init']);
  const changed = [...original];
  changed[0] = 'first change';
  changed[22] = 'last change';
  writeFileSync(join(repo, path), changed.join('\n') + '\n');
  const baseHead = git(repo, ['rev-parse', 'HEAD']).trim();
  const snapshots = [targetSnapshot(repo, path)];
  const changes = discoverSplitHunks(
    repo,
    baseHead,
    [{ status: 'M', path, addPaths: [path] }],
    snapshots,
  );
  const groups = [
    { message: 'fix: first', files: [], hunks: [{ path, ids: ['H1'] }] },
    { message: 'fix: second', files: [], hunks: [{ path, ids: ['H2'] }] },
  ];
  const tampered = {
    hunkMode: true,
    baseHead,
    changes: [
      {
        ...changes[0],
        hunks: [{ ...changes[0].hunks[0], hash: '0'.repeat(64) }, changes[0].hunks[1]],
      },
    ],
    groups,
  };

  assert.throws(() => validateHunkTransaction(repo, tampered, snapshots), /no longer matches/);
  assert.deepEqual(fallbackHunkGroups(groups, changes), [{ message: 'fix: first', files: [path] }]);
  assert.deepEqual(stripHunkCatalog(changes), [{ status: 'M', path, addPaths: [path] }]);
  assert.equal(git(repo, ['rev-list', '--count', 'HEAD']).trim(), '1');
  assert.equal(git(repo, ['status', '--porcelain']).trim(), 'M app.txt');
});

test('checkpoint resume continues a same-file hunk transaction without replaying the first hunk', async (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const path = 'app.txt';
  const original = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  writeFileSync(join(repo, path), original.join('\n') + '\n');
  git(repo, ['add', path]);
  git(repo, ['commit', '-qm', 'init']);
  const changed = [...original];
  changed[1] = 'first resumable change';
  changed[25] = 'second resumable change';
  writeFileSync(join(repo, path), changed.join('\n') + '\n');
  const baseHead = git(repo, ['rev-parse', 'HEAD']).trim();
  const snapshots = [targetSnapshot(repo, path)];
  const changes = discoverSplitHunks(
    repo,
    baseHead,
    [{ status: 'M', path, addPaths: [path] }],
    snapshots,
  );
  const groups = [
    { message: 'fix: commit first hunk', files: [], hunks: [{ path, ids: ['H1'] }] },
    { message: 'feat: commit second hunk', files: [], hunks: [{ path, ids: ['H2'] }] },
  ];
  const plan = createSplitPlanArtifact({
    scope: 'all',
    baseHead,
    fingerprint: getSplitStateFingerprint(repo, true, changes, 'all'),
    language: 'en',
    commitPolicy: DEFAULT_COMMIT_POLICY,
    changes,
    groups,
    hunkMode: true,
  });
  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  writeFileSync(
    hook,
    '#!/bin/sh\ncase "$(git show :app.txt)" in *"second resumable change"*) exit 1;; esac\n',
  );
  chmodSync(hook, 0o755);

  assert.equal(executeSplit(groups, repo, changes, false, 'all', { planArtifact: plan }), false);
  assert.equal(
    git(repo, ['log', '--reverse', '--format=%s']).trim(),
    'init\nfix: commit first hunk',
  );
  rmSync(hook);
  await resumeSplit(repo, { yes: true });
  assert.equal(
    git(repo, ['log', '--reverse', '--format=%s']).trim(),
    'init\nfix: commit first hunk\nfeat: commit second hunk',
  );
  assert.equal(git(repo, ['show', 'HEAD:app.txt']), changed.join('\n') + '\n');
  assert.equal(git(repo, ['status', '--porcelain']), '');
});
