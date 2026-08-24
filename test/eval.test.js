import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateEvalCases, loadEvalCases } from '../eval/run.mjs';

test('anonymous local eval covers every roadmap scenario with at least 99% compliance', () => {
  const report = evaluateEvalCases(loadEvalCases());
  assert.equal(report.scenarios, 8);
  assert.equal(report.categories, 8);
  assert.ok(report.candidates >= 30);
  assert.ok(report.formatCompliance >= 99, JSON.stringify(report.failures));
  assert.ok(report.classificationAccuracy >= 99, JSON.stringify(report.failures));
  assert.deepEqual(report.failures, []);
});
