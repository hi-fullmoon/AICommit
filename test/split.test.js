import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  abortSplit,
  normalizePlan,
  getAllChangedFiles,
  getStagedChangedFiles,
  executeSplit,
  condenseFileList,
  parsePlan,
  buildSplitPlanningContext,
  getSplitDiff,
  generateSplitPlan,
  getSplitStateFingerprint,
  captureUntrackedSnapshots,
  preflightSplit,
  resumeSplit,
  splitFlow,
} from '../src/split.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { readSplitCheckpoint, splitCheckpointPath } from '../src/split-checkpoint.js';
import { decodeUntrustedData } from '../src/trust.js';

// Fresh git repo for exercising the real git index operations behind
// executeSplit / getAllChangedFiles.
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'aicommit-split-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@test.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  return dir;
}

const M = (s) => ({ status: 'M', path: s });

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

test('normalizePlan sanitizes subject and body fields before returning them', () => {
  const groups = [
    {
      subject: 'feat: safe\u001b[2J title',
      body: '- keep this\u001b]52;c;YQ==\u0007 body',
      files: ['a.js'],
    },
  ];
  const result = normalizePlan(groups, [M('a.js')], 'en');
  assert.equal(result.length, 1);
  assert.equal(result[0].message, 'feat: safe title\n\n- keep this body');
  assert.doesNotMatch(result[0].message, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
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
    { subject: 'feat: dup', files: ['a.js'] }, // already assigned → empty → dropped
    { subject: '', files: ['a.js'] }, // no subject → dropped
    { files: ['a.js'] }, // no subject/body → dropped
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

test('incomplete split recovery does not depend on finish_reason and resends files without the diff', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = [];
  const replies = [
    {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: '[{"subject":"feat: partial"',
            reasoning_content: 'The tail only mentions late.js.',
          },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: '[{"subject":"feat: group files","files":["early.js","late.js"]}]',
          },
        },
      ],
    },
  ];
  let replyIndex = 0;
  globalThis.fetch = async (_url, opts) => {
    calls.push(JSON.parse(opts.body));
    return new Response(JSON.stringify(replies[replyIndex++]));
  };

  const { raw } = await generateSplitPlan(
    {
      apiUrl: 'https://example.test/v1/chat/completions',
      apiKey: '',
      modelId: 'mock-model',
      temperature: 0.3,
      language: 'en',
      maxTokens: 1024,
      timeoutMs: 1000,
      splitMaxDiffChars: 1000,
      splitMaxPlanFiles: 100,
      stripFiles: [],
      extraBody: {},
      reasoning: { mode: 'on', effort: 'medium', maxTokens: 4096 },
    },
    [M('early.js'), M('late.js')],
    'SECRET_DIFF_MARKER',
    process.cwd(),
  );

  assert.match(raw, /early\.js/);
  assert.equal(calls.length, 2);
  const recovery = calls[1].messages.at(-1).content;
  const envelope = recovery.match(
    /BEGIN_AICOMMIT_UNTRUSTED_JSON\n[^\n]*\nEND_AICOMMIT_UNTRUSTED_JSON/,
  );
  assert.ok(envelope);
  assert.deepEqual(decodeUntrustedData(envelope[0]), {
    kind: 'changed_files',
    untrusted: true,
    content: 'M early.js\nM late.js',
  });
  assert.match(recovery, /incomplete or malformed/);
  assert.ok(!calls[1].messages.some((m) => m.content.includes('SECRET_DIFF_MARKER')));
  assert.equal(calls[1].max_tokens, 4096);
});

test('split planning context includes bounded previews for untracked text files', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, 'new-feature.js'), 'export function newFeature() { return 42; }\n');
  const files = getAllChangedFiles(repo);

  const context = buildSplitPlanningContext(repo, files, '', 1000, []);
  assert.match(context, /Untracked file preview: new-feature\.js/);
  assert.match(context, /newFeature/);
  assert.ok(context.length <= 1000);
});

test('protected split previews redact credentials in ordinary untracked files', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, 'notes.txt'), 'API_KEY=preview-secret-value\n');
  const files = getAllChangedFiles(repo);

  const context = buildSplitPlanningContext(repo, files, '', 1000, [], true);
  assert.match(context, /API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(context, /preview-secret-value/);
});

test('untracked snapshot scans past the preview limit and across read boundaries', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(
    join(repo, 'notes.txt'),
    'x'.repeat(64 * 1024 - 5) + '\nAPI_KEY=deep-secret-value\n',
  );
  const files = getAllChangedFiles(repo);

  const snapshot = captureUntrackedSnapshots(repo, files);
  assert.match(snapshot.findings.join('\n'), /credential-like assignment in: notes\.txt/);
  assert.doesNotMatch(snapshot.previews.get('notes.txt'), /deep-secret-value/);
});

test('split planning reuses captured untracked bytes instead of reopening the file', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, 'notes.txt'), 'safe snapshot\n');
  const files = getAllChangedFiles(repo);
  const snapshot = captureUntrackedSnapshots(repo, files);
  const before = getSplitStateFingerprint(repo, false, files);

  writeFileSync(join(repo, 'notes.txt'), 'API_KEY=changed-after-scan\n');
  const context = buildSplitPlanningContext(repo, files, '', 1000, [], true, snapshot.previews);

  assert.match(context, /safe snapshot/);
  assert.doesNotMatch(context, /changed-after-scan/);
  assert.notEqual(getSplitStateFingerprint(repo, false, getAllChangedFiles(repo)), before);
});

test('split planning does not follow untracked symbolic links', (t) => {
  const repo = makeRepo();
  const outside = `${repo}-outside-secret.txt`;
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { force: true });
  });
  writeFileSync(outside, 'LOCAL_ONLY_SECRET=do-not-send\n');
  symlinkSync(outside, join(repo, 'linked-notes.txt'));
  const files = getAllChangedFiles(repo);

  const before = getSplitStateFingerprint(repo, false, files);
  const context = buildSplitPlanningContext(repo, files, '', 1000, []);
  writeFileSync(outside, 'LOCAL_ONLY_SECRET=changed-outside\n');
  const after = getSplitStateFingerprint(repo, false, files);

  assert.doesNotMatch(context, /LOCAL_ONLY_SECRET|do-not-send/);
  assert.doesNotMatch(context, /Untracked file preview: linked-notes\.txt/);
  assert.equal(after, before, 'outside target bytes are not part of Git symlink state');
});

test('split planning context reserves room for tracked and untracked changes', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, 'new.txt'), 'n'.repeat(2000));
  const files = getAllChangedFiles(repo);
  const tracked = 'diff --git a/a.txt b/a.txt\n+tracked change\n' + 't'.repeat(2000);

  const context = buildSplitPlanningContext(repo, files, tracked, 500, []);
  assert.match(context, /Untracked file preview: new\.txt/);
  assert.match(context, /Tracked changes:/);
  assert.match(context, /diff --git/);
  assert.ok(context.length <= 500);
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

test('unborn split diff includes edits made after a file was staged', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, 'new.txt'), 'staged version\n');
  execFileSync('git', ['add', 'new.txt'], { cwd: repo });
  writeFileSync(join(repo, 'new.txt'), 'working version\n');

  const diff = getSplitDiff(repo, false, 1);
  assert.match(diff, /\+staged version/);
  assert.match(diff, /-staged version/);
  assert.match(diff, /\+working version/);
});

test('staged split scope excludes unstaged content and untracked files', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, 'app.txt'), 'base\n');
  execFileSync('git', ['add', 'app.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  writeFileSync(join(repo, 'app.txt'), 'staged\n');
  execFileSync('git', ['add', 'app.txt'], { cwd: repo });
  writeFileSync(join(repo, 'app.txt'), 'unstaged\n');
  writeFileSync(join(repo, 'untracked.txt'), 'outside\n');

  assert.deepEqual(getStagedChangedFiles(repo), [
    { status: 'M', path: 'app.txt', addPaths: ['app.txt'] },
  ]);
  const diff = getSplitDiff(repo, true, 1, 'staged');
  assert.match(diff, /\+staged/);
  assert.doesNotMatch(diff, /unstaged|untracked/);

  const before = getSplitStateFingerprint(repo, true, undefined, 'staged');
  writeFileSync(join(repo, 'app.txt'), 'newer unstaged\n');
  assert.equal(getSplitStateFingerprint(repo, true, undefined, 'staged'), before);
  execFileSync('git', ['add', 'app.txt'], { cwd: repo });
  assert.notEqual(getSplitStateFingerprint(repo, true, undefined, 'staged'), before);
});

test('split state fingerprint detects changes to untracked file content', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, 'new.txt'), 'first version\n');
  const files = getAllChangedFiles(repo);
  const before = getSplitStateFingerprint(repo, false, files);

  writeFileSync(join(repo, 'new.txt'), 'second version\n');
  const after = getSplitStateFingerprint(repo, false, getAllChangedFiles(repo));
  assert.notEqual(after, before);
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

  const tracked = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf-8' })
    .trim()
    .split('\n')
    .sort();
  assert.deepEqual(tracked, ['a.txt', 'b.txt']);
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: repo,
    encoding: 'utf-8',
  }).trim();
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
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: repo,
    encoding: 'utf-8',
  }).trim();
  assert.equal(status, '');
  const tracked = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf-8' })
    .trim()
    .split('\n')
    .sort();
  assert.deepEqual(tracked, ['new.txt']);
});

test('executeSplit staged scope commits index blobs and preserves newer worktree edits', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, 'app.txt'), 'base\n');
  writeFileSync(join(repo, 'extra.txt'), 'base\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  writeFileSync(join(repo, 'app.txt'), 'staged\n');
  writeFileSync(join(repo, 'extra.txt'), 'staged extra\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  writeFileSync(join(repo, 'app.txt'), 'unstaged\n');

  const files = getStagedChangedFiles(repo);
  const groups = [
    { message: 'fix: stage app snapshot', files: ['app.txt'] },
    { message: 'feat: stage extra snapshot', files: ['extra.txt'] },
  ];
  assert.equal(executeSplit(groups, repo, files, false, 'staged'), true);
  assert.equal(
    execFileSync('git', ['show', 'HEAD:app.txt'], { cwd: repo, encoding: 'utf8' }),
    'staged\n',
  );
  assert.equal(execFileSync('git', ['diff', '--cached'], { cwd: repo, encoding: 'utf8' }), '');
  assert.match(execFileSync('git', ['diff'], { cwd: repo, encoding: 'utf8' }), /\+unstaged/);
});

test('split preflight rejects empty, duplicate, malformed rename, conflict, and submodule plans', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, 'app.txt'), 'base\n');
  execFileSync('git', ['add', 'app.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  writeFileSync(join(repo, 'app.txt'), 'next\n');
  execFileSync('git', ['add', 'app.txt'], { cwd: repo });
  const files = getStagedChangedFiles(repo);

  assert.throws(() => preflightSplit([], repo, files, 'staged'), /no groups/);
  assert.throws(
    () =>
      preflightSplit(
        [
          { message: 'fix: first', files: ['app.txt'] },
          { message: 'fix: second', files: ['app.txt'] },
        ],
        repo,
        files,
        'staged',
      ),
    /more than once/,
  );
  assert.throws(
    () =>
      preflightSplit(
        [{ message: 'fix: rename', files: ['old → new'] }],
        repo,
        [{ status: 'R', path: 'old → new', addPaths: ['new'] }],
        'staged',
      ),
    /both paths together/,
  );

  const stageOne = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: repo,
    encoding: 'utf8',
    input: 'one\n',
  }).trim();
  const stageTwo = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: repo,
    encoding: 'utf8',
    input: 'two\n',
  }).trim();
  execFileSync('git', ['update-index', '--index-info'], {
    cwd: repo,
    input: `0 0000000000000000000000000000000000000000\tapp.txt\n100644 ${stageOne} 1\tapp.txt\n100644 ${stageTwo} 2\tapp.txt\n`,
  });
  assert.throws(
    () =>
      preflightSplit(
        [{ message: 'fix: conflict', files: ['app.txt'] }],
        repo,
        [{ status: 'U', path: 'app.txt', addPaths: ['app.txt'] }],
        'staged',
      ),
    /unresolved conflicts/,
  );

  execFileSync('git', ['reset', '--hard', '-q', 'HEAD'], { cwd: repo });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${head},vendor/sub`], {
    cwd: repo,
  });
  assert.throws(
    () =>
      preflightSplit(
        [{ message: 'chore: update submodule', files: ['vendor/sub'] }],
        repo,
        [{ status: 'A', path: 'vendor/sub', addPaths: ['vendor/sub'] }],
        'staged',
      ),
    /does not support submodule/,
  );
});

test('all-scope hook failure before group one preserves the exact index and worktree', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, 'a.txt'), 'base a\n');
  writeFileSync(join(repo, 'b.txt'), 'base b\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'next a\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: repo });
  writeFileSync(join(repo, 'b.txt'), 'next b\n');
  const files = getAllChangedFiles(repo);
  const groups = [
    { message: 'fix: update a', files: ['a.txt'] },
    { message: 'fix: update b', files: ['b.txt'] },
  ];
  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  const report = preflightSplit(groups, repo, files, 'all');
  assert.deepEqual(report.hooks, ['pre-commit']);
  const indexBefore = readFileSync(join(repo, '.git', 'index'));
  const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });

  assert.equal(executeSplit(groups, repo, files, false, 'all'), false);
  assert.deepEqual(readFileSync(join(repo, '.git', 'index')), indexBefore);
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }),
    headBefore,
  );
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'next a\n');
  assert.equal(readFileSync(join(repo, 'b.txt'), 'utf8'), 'next b\n');
});

test('checkpoint resumes after a later hook failure without duplicate or omitted commits', async (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, 'a.txt'), 'base a\n');
  writeFileSync(join(repo, 'b.txt'), 'base b\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'next a checkpoint-secret-marker\n');
  writeFileSync(join(repo, 'b.txt'), 'next b checkpoint-secret-marker\n');
  const files = getAllChangedFiles(repo);
  const groups = [
    { message: 'fix: update a', files: ['a.txt'] },
    { message: 'fix: update b', files: ['b.txt'] },
  ];
  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  writeFileSync(
    hook,
    '#!/bin/sh\nif test "$(git diff --cached --name-only)" = "b.txt"; then exit 1; fi\n',
  );
  chmodSync(hook, 0o755);

  assert.equal(executeSplit(groups, repo, files, false, 'all'), false);
  assert.equal(
    execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    '2',
  );
  const interrupted = readSplitCheckpoint(repo);
  assert.equal(interrupted.checkpoint.completed.length, 1);
  assert.equal(interrupted.checkpoint.inFlight.index, 1);
  if (process.platform !== 'win32') assert.equal(statSync(interrupted.path).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(interrupted.path, 'utf8'), /checkpoint-secret-marker/);

  rmSync(hook);
  const result = await resumeSplit(repo, { yes: true });
  assert.equal(result.committed, true);
  assert.equal(
    execFileSync('git', ['log', '--reverse', '--format=%s'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim(),
    'init\nfix: update a\nfix: update b',
  );
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), '');
  assert.equal(existsSync(splitCheckpointPath(repo)), false);
});

test('resume reconciles a commit created in the checkpoint crash window exactly once', async (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, 'a.txt'), 'base a\n');
  writeFileSync(join(repo, 'b.txt'), 'base b\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'next a\n');
  writeFileSync(join(repo, 'b.txt'), 'next b\n');
  const files = getAllChangedFiles(repo);
  const groups = [
    { message: 'fix: update a', files: ['a.txt'] },
    { message: 'fix: update b', files: ['b.txt'] },
  ];

  assert.equal(
    executeSplit(groups, repo, files, false, 'all', {
      faultInjector(event, context) {
        if (event === 'after_commit_before_checkpoint' && context.index === 0) {
          throw new Error('simulated process crash');
        }
      },
    }),
    false,
  );
  const interrupted = readSplitCheckpoint(repo).checkpoint;
  assert.equal(interrupted.completed.length, 0);
  assert.equal(interrupted.inFlight.index, 0);
  assert.equal(
    execFileSync('git', ['log', '--reverse', '--format=%s'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim(),
    'init\nfix: update a',
  );

  await resumeSplit(repo, { yes: true });
  assert.equal(
    execFileSync('git', ['log', '--reverse', '--format=%s'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim(),
    'init\nfix: update a\nfix: update b',
  );
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), '');
  assert.equal(existsSync(splitCheckpointPath(repo)), false);
});

test('new split stops at an existing checkpoint and abort preserves current Git state', async (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, 'a.txt'), 'base a\n');
  writeFileSync(join(repo, 'b.txt'), 'base b\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'next a\n');
  writeFileSync(join(repo, 'b.txt'), 'next b\n');
  const files = getAllChangedFiles(repo);
  const groups = [
    { message: 'fix: update a', files: ['a.txt'] },
    { message: 'fix: update b', files: ['b.txt'] },
  ];
  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);

  assert.equal(executeSplit(groups, repo, files, false, 'all'), false);
  await assert.rejects(
    splitFlow(
      { ...DEFAULT_CONFIG, reasoning: { ...DEFAULT_CONFIG.reasoning, mode: 'off' } },
      repo,
      { scope: 'all', yes: true },
    ),
    /Cannot start a new split:[\s\S]*aicommit split resume[\s\S]*aicommit split abort/,
  );

  const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
  });
  const indexBefore = readFileSync(join(repo, '.git', 'index'));
  const statusBefore = execFileSync('git', ['status', '--porcelain'], {
    cwd: repo,
    encoding: 'utf8',
  });
  const result = await abortSplit(repo, { yes: true });

  assert.equal(result.exitReason, 'split_aborted');
  assert.equal(result.data.checkpointRemoved, true);
  assert.equal(existsSync(splitCheckpointPath(repo)), false);
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }),
    headBefore,
  );
  assert.deepEqual(readFileSync(join(repo, '.git', 'index')), indexBefore);
  assert.equal(
    execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }),
    statusBefore,
  );
});
