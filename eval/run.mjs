import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { normalizeCommitPolicy, validateCommitCandidate } from '../src/policy.js';

const REQUIRED_CATEGORIES = new Set([
  'single',
  'mixed',
  'rename',
  'generated',
  'long_diff',
  'zh',
  'en',
  'weak_model',
]);

export function evaluateEvalCases(cases) {
  if (!Array.isArray(cases) || !cases.length)
    throw new Error('Eval cases must be a non-empty array.');
  const seenIds = new Set();
  const seenCategories = new Set();
  let total = 0;
  let correct = 0;
  let accepted = 0;
  let acceptedCompliant = 0;
  let expectedValid = 0;
  const failures = [];

  for (const scenario of cases) {
    if (!scenario?.id || seenIds.has(scenario.id))
      throw new Error(`Duplicate or missing eval id: ${scenario?.id}`);
    seenIds.add(scenario.id);
    seenCategories.add(scenario.category);
    const policy = normalizeCommitPolicy(
      {
        ...(scenario.policy || {}),
        language: scenario.policy?.language || 'inherit',
      },
      scenario.language || 'en',
    );
    const diff = String(scenario.diff || '').repeat(scenario.repeatDiff || 1);
    for (const candidate of scenario.candidates || []) {
      total++;
      if (candidate.expectedValid) expectedValid++;
      const result = validateCommitCandidate(candidate.message, { policy, diff });
      if (result.valid) {
        accepted++;
        if (candidate.expectedValid) acceptedCompliant++;
      }
      if (result.valid === candidate.expectedValid) correct++;
      else {
        failures.push({
          scenario: scenario.id,
          message: candidate.message,
          expectedValid: candidate.expectedValid,
          actualValid: result.valid,
          issues: result.issues.map((issue) => issue.code),
        });
      }
    }
  }

  const missingCategories = [...REQUIRED_CATEGORIES].filter(
    (category) => !seenCategories.has(category),
  );
  if (missingCategories.length) {
    throw new Error(`Eval corpus is missing categories: ${missingCategories.join(', ')}`);
  }
  const classificationAccuracy = total ? (correct / total) * 100 : 0;
  const formatCompliance = accepted ? (acceptedCompliant / accepted) * 100 : 0;
  return {
    scenarios: cases.length,
    categories: seenCategories.size,
    candidates: total,
    expectedValid,
    accepted,
    classificationAccuracy,
    formatCompliance,
    failures,
  };
}

export function loadEvalCases(path = new URL('./cases.json', import.meta.url)) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main() {
  const report = evaluateEvalCases(loadEvalCases());
  console.log(
    `Eval: ${report.scenarios} scenarios / ${report.candidates} candidates / ` +
      `${report.categories} required categories`,
  );
  console.log(`Accepted-candidate format compliance: ${report.formatCompliance.toFixed(2)}%`);
  console.log(`Validator classification accuracy: ${report.classificationAccuracy.toFixed(2)}%`);
  if (report.failures.length) {
    for (const failure of report.failures) console.error(JSON.stringify(failure));
  }
  if (report.formatCompliance < 99 || report.classificationAccuracy < 99) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
