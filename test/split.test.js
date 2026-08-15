import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizePlan, getAllChangedFiles, executeSplit, condenseFileList, parsePlan } from '../src/split.js';

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

test('condenseFileList lists every file when under the cap', () => {
  const files = [M('a.js'), M('b.js'), M('c.js')];
  assert.equal(condenseFileList(files, 5), 'M a.js\nM b.js\nM c.js');
});

test('condenseFileList caps the list and notes how many files were hidden', () => {
  const files = Array.from({ length: 5 }, (_, i) => M(`f${i}.js`));
  const out = condenseFileList(files, 3);
  assert.ok(out.startsWith('M f0.js\nM f1.js\nM f2.js'));
  assert.match(out, /and 2 more files/);
});

test('condenseFileList applies the default cap when none is given', () => {
  const files = Array.from({ length: 105 }, (_, i) => M(`f${i}.js`));
  const out = condenseFileList(files);
  assert.match(out, /and 5 more files/);
  assert.ok(!out.includes('f100.js'));
});

test('parsePlan parses a complete JSON array', () => {
  const raw = '[{"subject":"feat: a","files":["a.js"]},{"subject":"chore: b","files":["b.js"]}]';
  const plan = parsePlan(raw);
  assert.equal(plan.length, 2);
  assert.equal(plan[1].subject, 'chore: b');
});

test('parsePlan tolerates trailing prose and a leading code fence', () => {
  const raw = '```json\n[{"subject":"feat: a","files":["a.js"]}]\n```\n以上就是我的计划。';
  const plan = parsePlan(raw);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].subject, 'feat: a');
});

test('parsePlan distinguishes prose from a truncated plan', () => {
  assert.throws(() => parsePlan('好的，我来分组。'), /contains no JSON array/);
  const truncated = '[{"subject":"feat: a","files":["a.js","b.js",';
  assert.throws(() => parsePlan(truncated), /truncated before the plan completed/);
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
