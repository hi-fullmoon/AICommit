import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invalidPlanMessages, applyMessageCorrections } from '../src/change-analysis.js';
import { normalizeCommitPolicy } from '../src/policy.js';

const policy = normalizeCommitPolicy(null, 'en');
const groups = [
  { ids: ['F1'], subject: `fix: ${'lengthy '.repeat(20)}`, files: ['src/a.js'], summary: 'Fix A' },
  { ids: ['F2'], subject: 'test: cover quota validation', files: ['test/a.js'] },
];

test('only invalid messages are sent for correction', () => {
  const invalid = invalidPlanMessages(groups, policy);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].id, '0');
  assert.match(invalid[0].errors, /exceeds/);
  assert.equal(invalid[0].subjectLength, 159);
  assert.equal(invalid[0].subjectMaxLength, 72);
  assert.equal(invalid[0].files, undefined);
});

test('message repair counts description characters separately from the complete header', () => {
  const shortPolicy = normalizeCommitPolicy({ subject: { maxLength: 2 } }, 'zh');
  const plan = [{ subject: 'fix(scope): 修复😀', files: ['src/policy.js'] }];
  assert.equal(invalidPlanMessages(plan, shortPolicy)[0].subjectLength, 3);
  const corrected = applyMessageCorrections(
    plan,
    [{ id: '0', subject: 'fix(scope): 修复' }],
    shortPolicy,
  );
  assert.deepEqual(invalidPlanMessages(corrected, shortPolicy), []);
  assert.deepEqual(corrected[0].files, plan[0].files);
});

test('message correction preserves file groups, summaries, and valid messages', () => {
  const result = applyMessageCorrections(
    groups,
    [
      {
        id: '0',
        subject: 'fix: align quota columns',
        body: '- Keep numeric values aligned',
        ids: ['F2'],
        files: ['unrelated.js'],
        summary: 'Untrusted replacement',
      },
    ],
    policy,
  );
  assert.deepEqual(result[0].ids, groups[0].ids);
  assert.deepEqual(result[0].files, groups[0].files);
  assert.equal(result[0].summary, groups[0].summary);
  assert.deepEqual(result[1], groups[1]);
  assert.equal(result[0].subject, 'fix: align quota columns');
  assert.match(groups[0].subject, /lengthy/);
  assert.deepEqual(invalidPlanMessages(result, policy), []);
});

test('invalid, missing, duplicate, and unrelated corrections are rejected', () => {
  for (const corrections of [
    [],
    [{ id: '1', subject: 'fix: valid but unrelated' }],
    [{ id: '0', subject: groups[0].subject }],
    [
      { id: '0', subject: 'fix: align columns' },
      { id: '0', subject: 'fix: align columns' },
    ],
  ])
    assert.throws(() => applyMessageCorrections(groups, corrections, policy));
});
