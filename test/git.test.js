import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getDiffStats, isLockFile, stripLockFileContent, condenseDiff } from '../src/git.js';

test('getDiffStats counts files and +/- lines, ignoring headers', () => {
  const diff = [
    'diff --git a/a.txt b/a.txt',
    'index 123..456 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,2 +1,2 @@',
    '-old line',
    '+new line',
    ' context',
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1 @@',
    '+brand new',
  ].join('\n');

  assert.deepEqual(getDiffStats(diff), { files: 2, additions: 2, deletions: 1 });
});

test('getDiffStats returns zeros for empty input', () => {
  assert.deepEqual(getDiffStats(''), { files: 0, additions: 0, deletions: 0 });
  assert.deepEqual(getDiffStats(null), { files: 0, additions: 0, deletions: 0 });
});

test('isLockFile recognizes common lock files by basename, case-insensitively', () => {
  for (const p of [
    'package-lock.json',
    'web/package-lock.json',
    'sub/Package-Lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'go.sum',
    'Cargo.lock',
    'api/.terraform.lock.hcl',
    'uv.lock',
  ]) {
    assert.equal(isLockFile(p), true, p);
  }
  for (const p of [
    'package.json',
    'package-lock.jsonc',
    'package.json.lock',
    'src/yarn.lock.backup',
    'backend/terraform.lock.hcl', // real name is ".terraform.lock.hcl"
    'Gemfile',
    'go.mod',
  ]) {
    assert.equal(isLockFile(p), false, p);
  }
});

test('stripLockFileContent stubs lock-file sections and keeps regular diffs', () => {
  const diff = [
    'diff --git a/src/index.js b/src/index.js',
    'index 1..2 100644',
    '--- a/src/index.js',
    '+++ b/src/index.js',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/package-lock.json b/package-lock.json',
    'index a..b 100644',
    '--- a/package-lock.json',
    '+++ b/package-lock.json',
    '@@ -1,5 +1,5 @@',
    '-"version": "1.0.0",',
    '+"version": "1.1.0",',
  ].join('\n');

  const out = stripLockFileContent(diff);
  assert.ok(out.includes('diff --git a/src/index.js'), 'keeps regular file');
  assert.ok(out.includes('-old') && out.includes('+new'), 'keeps regular hunks');
  assert.ok(out.includes('diff --git a/package-lock.json'), 'keeps lock header');
  assert.ok(out.includes('content omitted'), 'stubs lock body');
  assert.ok(!out.includes('"version": "1.1.0"'), 'drops lock hunks');
});

test('condenseDiff keeps complete sections up to the budget and prepends stat', () => {
  const diff = [
    'diff --git a/a.txt b/a.txt',
    'index 1..2 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '+a',
    'diff --git a/b.txt b/b.txt',
    'index 3..4 100644',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -1 +1 @@',
    '+b',
  ].join('\n');

  // Under budget: returned unchanged.
  const ok = condenseDiff(diff, 10_000, '');
  assert.equal(ok.diff, diff);
  assert.equal(ok.truncated, false);

  // Over budget: only a.txt's complete section survives, stat is prepended.
  const cut = condenseDiff(diff, 130, ' a.txt | 1 +\n 1 file changed, 1 insertion(+)');
  assert.equal(cut.truncated, true);
  assert.ok(cut.diff.startsWith(' a.txt | 1 +'), 'stat prepended');
  assert.ok(cut.diff.includes('+a'), 'first section kept');
  assert.ok(!cut.diff.includes('+b'), 'second section dropped');
  assert.ok(cut.diff.includes('diff truncated'), 'cut is marked');
});

test('condenseDiff with a single oversized section returns just the marker', () => {
  const one = 'diff --git a/big.txt b/big.txt\nindex 1..2 100644\n--- a/big.txt\n+++ b/big.txt\n@@ -1 +1 @@\n+x\n';
  const cut = condenseDiff(one, 50, '');
  assert.equal(cut.truncated, true);
  assert.ok(cut.diff.includes('diff truncated'));
});
