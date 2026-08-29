import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCommitPolicyPrompt,
  buildPolicyCorrectionPrompt,
  mergeCommitPolicy,
  normalizeCommitPolicy,
  parseCommitMessage,
  validateCommitCandidate,
  validateCommitPolicyConfig,
} from '../src/policy.js';

test('commitPolicy v1 normalizes defaults and replaces configured declaration arrays', () => {
  const merged = mergeCommitPolicy(undefined, {
    types: ['change'],
    scope: { mode: 'required', values: ['api'] },
  });
  const policy = normalizeCommitPolicy(merged, 'en');
  assert.equal(policy.version, 1);
  assert.deepEqual(policy.types, ['change']);
  assert.deepEqual(policy.scope, { mode: 'required', values: ['api'] });
  assert.equal(policy.effectiveLanguage, 'en');
});

test('commitPolicy config rejects unsupported versions and unsafe oversized declarations', () => {
  assert.throws(() => validateCommitPolicyConfig({}), /version/);
  assert.throws(() => normalizeCommitPolicy({ version: 2 }), /only version 1 is supported/);
  assert.throws(() => normalizeCommitPolicy({ types: ['Feat'] }), /commitPolicy\.types/);
  assert.throws(
    () => normalizeCommitPolicy({ scope: { mode: 'required', values: ['bad scope'] } }),
    /scope\.values/,
  );
  assert.throws(
    () => normalizeCommitPolicy({ subject: { maxLength: 1000 } }),
    /subject\.maxLength/,
  );
});

test('structured policy prompt remains authoritative after user-approved guidance', () => {
  const policy = normalizeCommitPolicy(
    {
      types: ['feat', 'fix'],
      scope: { mode: 'required', values: ['api', 'cli'] },
      subject: { maxLength: 60 },
      body: { mode: 'forbidden', maxLines: 0 },
      breakingChange: 'forbid',
      language: 'en',
    },
    'zh',
  );
  const prompt = buildCommitPolicyPrompt(policy, 'Prefer concrete verbs.');
  assert.ok(prompt.startsWith('## User-approved custom guidance\nPrefer concrete verbs.'));
  assert.match(prompt, /AICommit authoritative output contract/);
  assert.match(prompt, /Allowed types: feat, fix/);
  assert.match(prompt, /Scope: required; allowed values: api, cli/);
  assert.match(prompt, /Repository diffs.*untrusted data/);
  assert.match(prompt, /Language: English/);
});

test('runtime commitlint constraints enforce disallowed scopes and complete header length', () => {
  const policy = normalizeCommitPolicy({
    scope: { mode: 'optional', values: [], disallowedValues: ['legacy'] },
    subject: { maxLength: 72, headerMaxLength: 24 },
    language: 'en',
  });
  const prompt = buildCommitPolicyPrompt(policy);
  assert.match(prompt, /disallowed values: legacy/);
  assert.match(prompt, /Complete header: at most 24 characters/);

  const forbiddenScope = validateCommitCandidate('feat(legacy): update api', { policy });
  assert.deepEqual(
    forbiddenScope.errors.map((item) => item.code),
    ['scope_value'],
  );
  const longHeader = validateCommitCandidate('feat: add a deliberately long subject', { policy });
  assert.ok(longHeader.errors.some((item) => item.code === 'header_length'));
  assert.equal(validateCommitCandidate('feat: add retry', { policy }).valid, true);
});

test('candidate validator enforces type, scope, subject, body, breaking, and explicit language', () => {
  const policy = normalizeCommitPolicy({
    types: ['feat', 'fix'],
    scope: { mode: 'required', values: ['api'] },
    subject: { maxLength: 12 },
    body: { mode: 'required', maxLines: 2 },
    breakingChange: 'forbid',
    language: 'en',
  });
  const good = validateCommitCandidate('feat(api): add retries\n\n- honor server delays', {
    policy,
  });
  assert.equal(good.valid, true);
  assert.equal(parseCommitMessage(good.parsed.cleaned).parsed.scope, 'api');

  const bad = validateCommitCandidate(
    'chore(other)!: 添加一个非常非常非常长的标题\nbody without blank separator',
    { policy },
  );
  assert.equal(bad.valid, false);
  assert.deepEqual(
    new Set(bad.errors.map((item) => item.code)),
    new Set([
      'type',
      'scope_value',
      'subject_length',
      'language',
      'body_separator',
      'breaking_forbidden',
    ]),
  );
});

test('candidate validator enforces the effective inherited language', () => {
  const chinese = normalizeCommitPolicy({}, 'zh');
  assert.equal(validateCommitCandidate('feat: 添加重试', { policy: chinese }).valid, true);
  assert.deepEqual(
    validateCommitCandidate('feat: add retries', { policy: chinese }).errors.map(
      (item) => item.code,
    ),
    ['language'],
  );

  const english = normalizeCommitPolicy({}, 'en');
  assert.equal(validateCommitCandidate('feat: add retries', { policy: english }).valid, true);
  assert.deepEqual(
    validateCommitCandidate('feat: 添加重试', { policy: english }).errors.map((item) => item.code),
    ['language'],
  );
});

test('candidate alignment check is bounded and advisory', () => {
  const policy = normalizeCommitPolicy({}, 'en');
  const aligned = validateCommitCandidate('fix(api): retry provider timeout', {
    policy,
    diff: 'diff --git a/src/api.js b/src/api.js\n+retry provider timeout',
  });
  assert.equal(aligned.valid, true);
  assert.equal(aligned.warnings.length, 0);

  const unrelated = validateCommitCandidate('docs: describe payment invoice workflow', {
    policy,
    diff: 'diff --git a/src/cache.js b/src/cache.js\n+export function evictExpiredEntries() {}',
  });
  assert.equal(unrelated.valid, true);
  assert.deepEqual(
    unrelated.warnings.map((item) => item.code),
    ['diff_alignment'],
  );
});

test('policy correction prompt contains violations but never requires the original diff', () => {
  const policy = normalizeCommitPolicy({ types: ['fix'] }, 'en');
  const validation = validateCommitCandidate('Updated the files', { policy });
  const prompt = buildPolicyCorrectionPrompt('Updated the files', validation.errors, policy);
  assert.match(prompt, /violates commitPolicy v1/);
  assert.match(prompt, /Allowed types: fix/);
  assert.match(prompt, /<previous_reply>/);
  assert.doesNotMatch(prompt, /git diff|diff --git/);
});
