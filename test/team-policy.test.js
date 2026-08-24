import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readTeamPolicy,
  renderTeamPolicyTemplate,
  TEAM_POLICY_FILENAME,
  TEAM_POLICY_TEMPLATE,
  validateTeamPolicyDocument,
} from '../src/team-policy.js';

test('published team policy template matches the runtime template and is strictly valid', async () => {
  const published = await readFile(
    new URL('../templates/.aicommit.policy.json', import.meta.url),
    'utf8',
  );
  assert.deepEqual(JSON.parse(published), JSON.parse(renderTeamPolicyTemplate()));
  assert.deepEqual(validateTeamPolicyDocument(JSON.parse(published)), TEAM_POLICY_TEMPLATE);
});

test('team policy rejects unsafe, partial, oversized, and symlinked documents', async (t) => {
  assert.throws(
    () => validateTeamPolicyDocument({ ...TEAM_POLICY_TEMPLATE, apiKey: 'must-not-be-accepted' }),
    /unknown properties: apiKey/,
  );
  assert.throws(
    () => validateTeamPolicyDocument({ ...TEAM_POLICY_TEMPLATE, commitPolicy: { version: 1 } }),
    /missing required properties/,
  );

  const root = await mkdtemp(join(tmpdir(), 'aicommit-team-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policyPath = join(root, TEAM_POLICY_FILENAME);
  await writeFile(policyPath, 'x'.repeat(64 * 1024 + 1));
  await assert.rejects(() => readTeamPolicy(root), /exceeds 64 KiB/);

  await rm(policyPath);
  const target = join(root, 'target.json');
  await writeFile(target, renderTeamPolicyTemplate());
  await symlink(target, policyPath);
  await assert.rejects(() => readTeamPolicy(root), /non-symlinked/);
});
