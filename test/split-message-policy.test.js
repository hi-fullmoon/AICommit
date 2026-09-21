import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlanMessages } from '../src/change-analysis.js';
import { normalizeCommitPolicy } from '../src/policy.js';

test('split validation rejects missing or invalid subjects even with a valid header in the body', () => {
  const policy = normalizeCommitPolicy({}, 'en');
  for (const subject of [undefined, null, '', ' \n\t ', 42, {}]) {
    assert.throws(
      () => validatePlanMessages([{ subject, body: 'fix: validate split messages' }], policy),
      /Group 1: The subject field must be a non-empty commit header/,
    );
  }
  assert.doesNotThrow(() =>
    validatePlanMessages([{ subject: '  fix: validate split messages  ' }], policy),
  );
});

test('split message validation reports group numbers and actionable policy errors', () => {
  const policy = normalizeCommitPolicy({ types: ['fix'], scope: { mode: 'required' } }, 'en');
  assert.throws(
    () =>
      validatePlanMessages(
        [{ subject: 'fix(api): validate split messages' }, { subject: 'feat: repair planning' }],
        policy,
      ),
    (error) => {
      assert.match(error.message, /Group 2:/);
      assert.match(error.message, /Type "feat" is not allowed/);
      assert.match(error.message, /A scope is required/);
      assert.doesNotMatch(error.message, /Group 1:/);
      return true;
    },
  );
});

test('split validation checks required bodies and accepts a compliant plan without mutating it', () => {
  const policy = normalizeCommitPolicy({ body: { mode: 'required' } }, 'en');
  const groups = [{ subject: 'fix: validate split messages' }];
  assert.throws(() => validatePlanMessages(groups, policy), /body/i);
  groups[0].body = 'Validate each planning batch before accepting the generated messages.';
  const before = groups.map((group) => ({ ...group }));
  assert.doesNotThrow(() => validatePlanMessages(groups, policy));
  assert.deepEqual(groups, before);
});

test('split validation rejects plain titles and overlong subjects before accepting a batch', () => {
  const policy = normalizeCommitPolicy({ subject: { maxLength: 12 } }, 'en');
  assert.throws(() => validatePlanMessages([{ subject: 'Update planning' }], policy), /first line/);
  assert.throws(
    () => validatePlanMessages([{ subject: 'fix: validate split commit messages' }], policy),
    /Subject exceeds 12/,
  );
});
