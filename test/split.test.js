import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizePlan } from '../src/split.js';

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
