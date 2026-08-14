import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizePlan, getAllChangedFiles, executeSplit } from '../src/split.js';

// Fresh git repo for exercising the real git index operations behind
// executeSplit / getAllChangedFiles.
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'aicommit-split-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@test.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  return dir;
}

const M = s => ({ status: 'M', path: s });

test('normalizePlan assembles a subject+body message from subject/body fields', () => {
  const groups = [
    { subject: 'feat: add login', body: 'Add a login form and session handling.', files: ['a.js'] },
  ];
  const result = normalizePlan(groups, [M('a.js')], 'en');
  assert.equal(result.length, 1);
  assert.equal(result[0].message, 'feat: add login\n\nAdd a login form and session handling.');
});

test('normalizePlan falls back to a single message field (may contain a body)', () => {
  const groups = [{ message: 'fix: crash\n\nHandle the null case.', files: ['a.js'] }];
  const result = normalizePlan(groups, [M('a.js')], 'en');
  assert.equal(result.length, 1);
  assert.equal(result[0].message, 'fix: crash\n\nHandle the null case.');
});

test('normalizePlan uses the subject alone when no body is given', () => {
  const groups = [{ subject: 'chore: bump deps', files: ['a.js'] }];
  const result = normalizePlan(groups, [M('a.js')], 'en');
  assert.equal(result.length, 1);
  assert.equal(result[0].message, 'chore: bump deps');
});

test('normalizePlan sweeps leftover files into a catch-all group', () => {
  const groups = [{ subject: 'feat: a', files: ['a.js'] }];
  const result = normalizePlan(groups, [M('a.js'), M('b.js')], 'en');
  assert.equal(result.length, 2);
  assert.deepEqual(result[1].files, ['b.js']);
  assert.match(result[1].message, /update remaining files/);
});

test('normalizePlan drops unknown, duplicate, and empty groups', () => {
  const allFiles = [M('a.js')];
  const groups = [
    { subject: 'feat: a', body: 'x', files: ['a.js', 'ghost.js'] }, // ghost dropped
    { subject: 'feat: dup', files: ['a.js'] },                      // already assigned → empty → dropped
    { subject: '', files: ['a.js'] },                               // no subject → dropped
    { files: ['a.js'] },                                            // no subject/body → dropped
  ];
  const result = normalizePlan(groups, allFiles, 'en');
  assert.equal(result.length, 1);
  assert.equal(result[0].message, 'feat: a\n\nx');
});

test('getAllChangedFiles keeps both paths for a rename', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, 'old.txt'), 'hello');
  execFileSync('git', ['add', 'old.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  execFileSync('git', ['mv', 'old.txt', 'new.txt'], { cwd: repo });

  const files = getAllChangedFiles(repo);
  assert.equal(files.length, 1);
  assert.equal(files[0].status, 'R');
  assert.deepEqual(files[0].addPaths, ['old.txt', 'new.txt']);
  assert.ok(files[0].path.includes('old.txt') && files[0].path.includes('new.txt'));
});

test('executeSplit on an unborn branch commits every group without deleting earlier files', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, 'a.txt'), 'a');
  writeFileSync(join(repo, 'b.txt'), 'b');

  const groups = [
    { message: 'feat: add a', files: ['a.txt'] },
    { message: 'feat: add b', files: ['b.txt'] },
  ];
  const allFiles = [
    { status: '??', path: 'a.txt', addPaths: ['a.txt'] },
    { status: '??', path: 'b.txt', addPaths: ['b.txt'] },
  ];

  executeSplit(groups, repo, allFiles);

  const tracked = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf-8' }).trim().split('\n').sort();
  assert.deepEqual(tracked, ['a.txt', 'b.txt']);
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf-8' }).trim();
  assert.equal(status, '');
});

test('executeSplit commits a rename as one unit (both paths)', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, 'old.txt'), 'hello');
  execFileSync('git', ['add', 'old.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  execFileSync('git', ['mv', 'old.txt', 'new.txt'], { cwd: repo });

  const groups = [{ message: 'refactor: rename old to new', files: ['old.txt → new.txt'] }];
  const allFiles = [{ status: 'R', path: 'old.txt → new.txt', addPaths: ['old.txt', 'new.txt'] }];

  executeSplit(groups, repo, allFiles);

  // No leftover deletion, and only the destination remains tracked.
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf-8' }).trim();
  assert.equal(status, '');
  const tracked = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf-8' }).trim().split('\n').sort();
  assert.deepEqual(tracked, ['new.txt']);
});
