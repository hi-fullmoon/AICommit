import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderTeamPolicyTemplate, TEAM_POLICY_FILENAME } from '../src/team-policy.js';

const CLI = fileURLToPath(new URL('../bin/aicommit.js', import.meta.url));

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function runCli(cwd, home, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      ...extraEnv,
    },
    encoding: 'utf8',
  });
  return {
    code: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test('local message files and CI ranges use the same committed team policy', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-policy-command-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const ciHome = join(root, 'ci-home');
  const repo = join(root, 'repo');
  mkdirSync(home);
  mkdirSync(ciHome);
  mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'policy@example.com']);
  git(repo, ['config', 'user.name', 'Policy Test']);

  const helperMarker = join(root, 'credential-helper-called');
  git(repo, [
    'config',
    'credential.helper',
    '!f() { : > "$AICOMMIT_HELPER_MARKER"; echo password=helper-secret; }; f',
  ]);
  writeFileSync(
    join(home, '.aicommit.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      language: 'zh',
      defaultProvider: 'personal',
      providers: {
        personal: {
          providerType: 'custom',
          apiUrl: 'https://api.example.test/v1/chat/completions',
          apiKeyEnv: 'AICOMMIT_POLICY_TEST_KEY',
          defaultModel: 'default',
          models: {
            default: { modelId: 'policy-test-model' },
          },
        },
      },
      commitPolicy: {
        version: 1,
        types: ['chore'],
        scope: { mode: 'forbidden', values: [] },
        subject: { maxLength: 20 },
        body: { mode: 'forbidden', maxLines: 0 },
        breakingChange: 'forbid',
        language: 'zh',
      },
      credentialHelper: { enabled: true, username: 'aicommit' },
      repositoryContext: { commitlint: { enabled: false } },
    }),
  );
  const teamPolicy = JSON.parse(renderTeamPolicyTemplate());
  teamPolicy.commitPolicy.scope = { mode: 'required', values: ['api'] };
  writeFileSync(join(repo, TEAM_POLICY_FILENAME), `${JSON.stringify(teamPolicy, null, 2)}\n`);
  writeFileSync(
    join(repo, 'commitlint.config.cjs'),
    "module.exports = { rules: { 'type-enum': [2, 'always', ['feat']] } };\n",
  );

  const message = 'feat(api): add deterministic team policy checks\n';
  const messagePath = join(root, 'COMMIT_EDITMSG');
  writeFileSync(messagePath, message);
  const env = {
    AICOMMIT_POLICY_TEST_KEY: 'environment-secret-must-not-be-read',
    AICOMMIT_HELPER_MARKER: helperMarker,
  };

  const local = runCli(
    repo,
    home,
    ['policy', 'check', `--file=${messagePath}`, '--output=json'],
    env,
  );
  assert.equal(local.code, 0, local.stdout + local.stderr);
  const localOutput = JSON.parse(local.stdout);
  assert.equal(localOutput.data.valid, true);
  assert.equal(localOutput.data.policy.effectiveLanguage, 'en');
  assert.deepEqual(localOutput.data.policy.types, ['feat']);
  assert.deepEqual(localOutput.data.policy.scope, { mode: 'required', values: ['api'] });
  assert.equal(localOutput.data.commitlintSource, 'commitlint.config.cjs');

  writeFileSync(join(repo, 'policy.txt'), 'team policy\n');
  git(repo, ['add', 'policy.txt', TEAM_POLICY_FILENAME, 'commitlint.config.cjs']);
  git(repo, ['commit', '-qm', message.trim()]);
  const ci = runCli(repo, ciHome, ['policy', 'check', '--range=HEAD', '--output=json']);
  assert.equal(ci.code, 0, ci.stdout + ci.stderr);
  const ciOutput = JSON.parse(ci.stdout);
  assert.equal(ciOutput.data.policyFingerprint, localOutput.data.policyFingerprint);
  assert.deepEqual(ciOutput.data.policy, localOutput.data.policy);
  assert.deepEqual(ciOutput.data.results[0].issues, localOutput.data.results[0].issues);
  assert.equal(ciOutput.data.results[0].valid, localOutput.data.results[0].valid);

  writeFileSync(messagePath, 'chore: 添加不符合团队规则的提交\n');
  const invalid = runCli(
    repo,
    home,
    ['policy', 'check', `--file=${messagePath}`, '--output=json'],
    env,
  );
  assert.equal(invalid.code, 2, invalid.stdout + invalid.stderr);
  const invalidOutput = JSON.parse(invalid.stdout);
  assert.equal(invalidOutput.ok, false);
  assert.equal(invalidOutput.data.valid, false);
  assert.doesNotMatch(invalid.stdout, /chore|添加不符合团队规则的提交/);
  assert.deepEqual(
    new Set(invalidOutput.data.results[0].issues.map((issue) => issue.code)),
    new Set(['type', 'scope_required', 'language']),
  );
  assert.equal(existsSync(helperMarker), false);
  assert.doesNotMatch(
    local.stdout + local.stderr + ci.stdout + ci.stderr + invalid.stdout + invalid.stderr,
    /environment-secret-must-not-be-read|helper-secret/,
  );

  const missing = runCli(
    repo,
    home,
    ['policy', 'check', `--file=${join(root, 'missing-message')}`, '--output=json'],
    env,
  );
  assert.equal(missing.code, 2, missing.stdout + missing.stderr);
  assert.equal(JSON.parse(missing.stdout).error.category, 'config');

  const template = runCli(repo, home, ['policy', 'template'], env);
  assert.equal(template.code, 0, template.stdout + template.stderr);
  assert.deepEqual(
    JSON.parse(template.stdout),
    JSON.parse(
      readFileSync(new URL('../templates/.aicommit.policy.json', import.meta.url), 'utf8'),
    ),
  );
  assert.doesNotMatch(template.stdout, /apiKey|credential|endpoint/i);
});
