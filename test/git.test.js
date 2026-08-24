import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getDiffStats,
  isLockFile,
  matchStripPattern,
  stripLockFileContent,
  condenseDiff,
  unifiedArg,
  getChangedFiles,
  getUnstagedFiles,
  getUntrackedFiles,
  getStagedDiff,
  getIndexFingerprint,
  createIndexTransaction,
  protectSensitiveDiff,
  protectSensitiveText,
  isSensitiveFile,
  gitCommit,
} from '../src/git.js';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'aicommit-test-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@example.com && git config user.name Test', { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  writeFileSync(join(dir, 'b.txt'), 'two\n');
  execSync('git add . && git commit -qm init', { cwd: dir });
  return dir;
}

test('getChangedFiles lists only staged paths; getUnstagedFiles only working-tree changes', () => {
  const dir = makeRepo();
  try {
    // Staged change: a.txt. Unstaged change: b.txt.
    writeFileSync(join(dir, 'a.txt'), 'one changed\n');
    execSync('git add a.txt', { cwd: dir });
    writeFileSync(join(dir, 'b.txt'), 'two changed\n');

    assert.deepEqual(
      getChangedFiles(dir).map((f) => f.path),
      ['a.txt'],
    );
    assert.deepEqual(
      getUnstagedFiles(dir).map((f) => f.path),
      ['b.txt'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getUnstagedFiles returns empty on a clean tree', () => {
  const dir = makeRepo();
  try {
    assert.deepEqual(getUnstagedFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getUnstagedFiles exposes real paths for staging via addPaths', () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, 'b.txt'), 'two changed\n');
    const [file] = getUnstagedFiles(dir);
    assert.equal(file.path, 'b.txt');
    assert.deepEqual(file.addPaths, ['b.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git file lists preserve Unicode and whitespace paths for selective staging', () => {
  const dir = makeRepo();
  try {
    const tracked = '中文 文件.txt';
    const untracked = '新 文件.txt';
    writeFileSync(join(dir, tracked), 'initial\n');
    execFileSync('git', ['add', '--', tracked], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'add unicode path'], { cwd: dir });
    writeFileSync(join(dir, tracked), 'changed\n');
    writeFileSync(join(dir, untracked), 'new\n');

    const [modified] = getUnstagedFiles(dir);
    assert.equal(modified.path, tracked);
    assert.deepEqual(modified.addPaths, [tracked]);
    assert.deepEqual(getUntrackedFiles(dir), [untracked]);

    // The values returned by the helpers must be safe to pass directly back
    // to git, which was the failing path in the interactive picker.
    execFileSync('git', ['add', '--', ...modified.addPaths, untracked], { cwd: dir });
    assert.deepEqual(
      getChangedFiles(dir)
        .map((f) => f.path)
        .sort(),
      [tracked, untracked].sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git read failures surface command context instead of looking like no changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aicommit-not-repo-'));
  try {
    assert.throws(() => getStagedDiff(dir, 1), /git diff --unified=1 --staged failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test('sensitive model input protection omits risky files and redacts credentials', () => {
  const diff = [
    'diff --git a/.env b/.env',
    '--- /dev/null',
    '+++ b/.env',
    '@@ -0,0 +1 @@',
    '+API_KEY=super-secret-value',
    'diff --git a/src/config.js b/src/config.js',
    '--- a/src/config.js',
    '+++ b/src/config.js',
    '@@ -1 +1 @@',
    '+const accessToken = "token-value-12345";',
  ].join('\n');

  const protectedInput = protectSensitiveDiff(diff);
  assert.match(protectedInput.diff, /sensitive file — content omitted/);
  assert.doesNotMatch(protectedInput.diff, /super-secret-value/);
  assert.doesNotMatch(protectedInput.diff, /token-value-12345/);
  assert.match(protectedInput.diff, /\[REDACTED\]/);
  assert.ok(protectedInput.findings.length >= 2);
  assert.equal(isSensitiveFile('.env.production'), true);
  assert.equal(isSensitiveFile('.env.example'), false);
  assert.equal(isSensitiveFile('.aicommit.config.json'), true);

  const preview = protectSensitiveText(
    'API_KEY=preview-secret-value\nAWS=AKIAABCDEFGHIJKLMNOP\n',
    'notes.txt',
  );
  assert.doesNotMatch(preview.text, /preview-secret-value|AKIAABCDEFGHIJKLMNOP/);
  assert.match(preview.text, /\[REDACTED\]/);
  assert.equal(preview.findings.length, 2);
});

test('index fingerprint changes with staged content and transaction restores prior staging', () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, 'a.txt'), 'staged first\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: dir });
    const before = getIndexFingerprint(dir);
    const tx = createIndexTransaction(dir);

    writeFileSync(join(dir, 'b.txt'), 'staged second\n');
    execFileSync('git', ['add', 'b.txt'], { cwd: dir });
    tx.markOwned();
    assert.notEqual(getIndexFingerprint(dir), before);
    assert.equal(tx.restore(), true);

    assert.equal(getIndexFingerprint(dir), before);
    assert.deepEqual(
      getChangedFiles(dir).map((file) => file.path),
      ['a.txt'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('index transaction does not overwrite a concurrent index change', () => {
  const dir = makeRepo();
  try {
    const tx = createIndexTransaction(dir);
    writeFileSync(join(dir, 'a.txt'), 'tool change\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: dir });
    tx.markOwned();

    writeFileSync(join(dir, 'b.txt'), 'external change\n');
    execFileSync('git', ['add', 'b.txt'], { cwd: dir });
    assert.equal(tx.restore(), false);
    assert.deepEqual(
      getChangedFiles(dir)
        .map((file) => file.path)
        .sort(),
      ['a.txt', 'b.txt'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gitCommit propagates Git failures', () => {
  const dir = makeRepo();
  try {
    assert.throws(() => gitCommit('chore: no changes', dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('matchStripPattern matches basenames with * and ? wildcards, case-insensitively', () => {
  const patterns = ['*.min.js', '*.map', 'asset-?.png'];
  assert.equal(matchStripPattern('dist/app.min.js', patterns), true);
  assert.equal(matchStripPattern('app.MIN.JS', patterns), true);
  assert.equal(matchStripPattern('dist/bundle.js.map', patterns), true);
  assert.equal(matchStripPattern('img/asset-1.png', patterns), true);
  assert.equal(matchStripPattern('src/app.js', patterns), false);
  assert.equal(matchStripPattern('asset-12.png', patterns), false);
  assert.equal(matchStripPattern('src/app.js', []), false);
  assert.equal(matchStripPattern('src/app.js', null), false);
  assert.equal(matchStripPattern('src/app.js', ['', 42]), false);
});

test('unifiedArg builds --unified=<n> and falls back to 1 for bad input', () => {
  assert.equal(unifiedArg(0), '--unified=0');
  assert.equal(unifiedArg(1), '--unified=1');
  assert.equal(unifiedArg(3), '--unified=3');
  assert.equal(unifiedArg(undefined), '--unified=1');
  assert.equal(unifiedArg(-1), '--unified=1');
  assert.equal(unifiedArg(1.5), '--unified=1');
  assert.equal(unifiedArg('1'), '--unified=1');
});

test('stripLockFileContent also stubs sections matched by stripFiles globs', () => {
  const diff = [
    'diff --git a/src/index.js b/src/index.js',
    'index 1..2 100644',
    '--- a/src/index.js',
    '+++ b/src/index.js',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/dist/app.min.js b/dist/app.min.js',
    'index a..b 100644',
    '--- a/dist/app.min.js',
    '+++ b/dist/app.min.js',
    '@@ -1 +1 @@',
    '-minifiedOld',
    '+minifiedNew',
  ].join('\n');

  const out = stripLockFileContent(diff, ['*.min.js']);
  assert.ok(out.includes('diff --git a/src/index.js'), 'keeps regular file');
  assert.ok(out.includes('+new'), 'keeps regular hunks');
  assert.ok(out.includes('diff --git a/dist/app.min.js'), 'keeps stubbed header');
  assert.ok(out.includes('generated file — content omitted'), 'stubs glob-matched body');
  assert.ok(!out.includes('minifiedNew'), 'drops glob-matched hunks');
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
  const one =
    'diff --git a/big.txt b/big.txt\nindex 1..2 100644\n--- a/big.txt\n+++ b/big.txt\n@@ -1 +1 @@\n+x\n';
  const cut = condenseDiff(one, 50, '');
  assert.equal(cut.truncated, true);
  assert.ok(cut.diff.includes('diff truncated'));
});

test('condenseDiff caps a single oversized file section, keeping other files', () => {
  const bigSection =
    [
      'diff --git a/big.txt b/big.txt',
      'index 1..2 100644',
      '--- a/big.txt',
      '+++ b/big.txt',
      '@@ -1 +1 @@',
      '+' + 'x'.repeat(500),
    ].join('\n') + '\n';
  const smallSection = [
    'diff --git a/small.txt b/small.txt',
    'index 3..4 100644',
    '--- a/small.txt',
    '+++ b/small.txt',
    '@@ -1 +1 @@',
    '+small',
  ].join('\n');
  const diff = bigSection + smallSection;

  // Under the total budget, but big.txt exceeds the per-file cap: its section
  // is truncated at a line boundary while small.txt survives intact.
  const cut = condenseDiff(diff, 10_000, '', 120);
  assert.equal(cut.truncated, true);
  assert.ok(cut.diff.includes('diff --git a/big.txt'), 'big file header kept');
  assert.ok(cut.diff.includes('file section truncated'), 'per-file cut marked');
  assert.ok(!cut.diff.includes('x'.repeat(500)), 'big file body cut');
  assert.ok(cut.diff.includes('+small'), 'small file kept whole');
  // No line is cut mid-content: the kept big-file body ends at a newline.
  const kept = cut.diff.split('file section truncated')[0];
  assert.ok(kept.endsWith('\n... ('), 'cut lands on a line boundary');
});

test('condenseDiff per-file cap feeds into the total-budget pass when still over', () => {
  const sections = [];
  for (let i = 0; i < 5; i++) {
    sections.push(
      [
        `diff --git a/f${i}.txt b/f${i}.txt`,
        'index 1..2 100644',
        `--- a/f${i}.txt`,
        `+++ b/f${i}.txt`,
        '@@ -1 +1 @@',
        '+' + 'y'.repeat(200),
      ].join('\n'),
    );
  }
  const diff = sections.join('\n');

  // Per-file cap shrinks each section, but the total still exceeds maxChars:
  // later files are dropped and the stat summary is prepended.
  const cut = condenseDiff(diff, 400, 'STAT', 120);
  assert.equal(cut.truncated, true);
  assert.ok(cut.diff.startsWith('STAT'), 'stat prepended');
  assert.ok(cut.diff.includes('diff --git a/f0.txt'), 'first file kept');
  assert.ok(cut.diff.includes('diff truncated'), 'total cut marked');
  assert.ok(!cut.diff.includes('y'.repeat(200)), 'no section kept whole');
});
