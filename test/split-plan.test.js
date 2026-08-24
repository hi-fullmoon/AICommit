import { mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_COMMIT_POLICY } from '../src/policy.js';
import {
  createSplitPlanArtifact,
  readSplitPlanArtifact,
  validateSplitPlanArtifact,
  writeSplitPlanArtifact,
} from '../src/split-plan.js';

function validPlan(overrides = {}) {
  return createSplitPlanArtifact({
    scope: 'staged',
    baseHead: 'a'.repeat(40),
    fingerprint: 'b'.repeat(64),
    language: 'en',
    commitPolicy: DEFAULT_COMMIT_POLICY,
    changes: [
      { status: 'M', path: 'src/app.js', addPaths: ['src/app.js'] },
      { status: 'A', path: 'test/app.test.js', addPaths: ['test/app.test.js'] },
    ],
    groups: [
      { message: 'fix: update app behavior', files: ['src/app.js'] },
      { message: 'test: cover app behavior', files: ['test/app.test.js'] },
    ],
    createdAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  });
}

test('split plan artifact round-trips atomically with owner-only permissions', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-plan-artifact-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'nested', 'plan.json');
  const expected = validPlan();
  const written = await writeSplitPlanArtifact(path, expected);
  assert.equal(written, path);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  const loaded = await readSplitPlanArtifact(path);
  assert.deepEqual(loaded.artifact, expected);

  const schema = JSON.parse(
    await readFile(new URL('../schemas/aicommit-split-plan.schema.json', import.meta.url), 'utf8'),
  );
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(new Set(schema.required), new Set(Object.keys(expected)));
});

test('split plan validation rejects empty, duplicate, unknown, unsafe, and non-policy groups', () => {
  const base = validPlan();
  assert.throws(() => validateSplitPlanArtifact({ ...base, extra: true }), /unknown top-level/);
  assert.throws(
    () => validateSplitPlanArtifact({ ...base, groups: [{ message: 'fix: x', files: [] }] }),
    /must not be empty/,
  );
  assert.throws(
    () =>
      validateSplitPlanArtifact({
        ...base,
        groups: [
          { message: 'fix: first', files: ['src/app.js'] },
          { message: 'fix: duplicate', files: ['src/app.js', 'test/app.test.js'] },
        ],
      }),
    /more than one group/,
  );
  assert.throws(
    () =>
      validateSplitPlanArtifact({
        ...base,
        changes: [{ status: 'M', path: '../outside', addPaths: ['../outside'] }],
        groups: [{ message: 'fix: unsafe', files: ['../outside'] }],
      }),
    /safe repository-relative/,
  );
  assert.throws(
    () =>
      validateSplitPlanArtifact({
        ...base,
        groups: [{ message: 'updated files', files: ['src/app.js', 'test/app.test.js'] }],
      }),
    /violates commitPolicy/,
  );
});

test('split plan reader rejects symbolic links', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-plan-symlink-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'target.json');
  await writeSplitPlanArtifact(target, validPlan());
  const link = join(root, 'link.json');
  symlinkSync(target, link);
  await assert.rejects(() => readSplitPlanArtifact(link), /regular, non-symbolic-link/);
});
