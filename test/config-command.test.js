import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/aicommit.js', import.meta.url));

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

test('config show/validate/path are redacted, credential-free, and automation-safe', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-config-command-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const helperMarker = join(root, 'credential-helper-called');
  execFileSync(
    'git',
    [
      'config',
      'credential.helper',
      '!f() { : > "$AICOMMIT_HELPER_MARKER"; echo password=helper-secret; }; f',
    ],
    { cwd: repo },
  );
  const userPath = join(home, '.aicommit.config.json');
  const projectPath = join(repo, '.aicommit.config.json');
  writeFileSync(
    userPath,
    JSON.stringify({
      apiUrl: 'https://api.example.test/v1/chat/completions',
      apiKey: '',
      apiKeyEnv: 'AICOMMIT_CONFIG_COMMAND_KEY',
      modelId: 'test-model',
      language: 'zh',
      credentialHelper: { enabled: true, username: 'aicommit' },
    }),
  );
  writeFileSync(
    projectPath,
    JSON.stringify({
      language: 'en',
      apiKey: 'project-secret-must-be-ignored',
      apiUrl: 'https://attacker.example/v1',
    }),
  );
  const env = {
    AICOMMIT_CONFIG_COMMAND_KEY: 'environment-secret-must-not-be-read',
    AICOMMIT_HELPER_MARKER: helperMarker,
  };

  const shown = runCli(repo, home, ['config', 'show', '--output=json'], env);
  assert.equal(shown.code, 0, shown.stdout + shown.stderr);
  const output = JSON.parse(shown.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.exitReason, 'config_show');
  assert.deepEqual(output.data.sources, ['user', 'project']);
  assert.equal(output.data.config.language, 'en');
  assert.equal(output.data.config.apiKey, '(not set)');
  assert.equal(output.data.config.apiKeyEnv, 'AICOMMIT_CONFIG_COMMAND_KEY');
  assert.match(shown.stderr, /Ignored unsafe settings/);
  assert.doesNotMatch(
    shown.stdout + shown.stderr,
    /environment-secret-must-not-be-read|helper-secret|project-secret-must-be-ignored/,
  );
  assert.equal(existsSync(helperMarker), false);

  const validated = runCli(repo, home, ['config', 'validate', '--output=json'], env);
  assert.equal(validated.code, 0, validated.stdout + validated.stderr);
  assert.equal(JSON.parse(validated.stdout).exitReason, 'config_valid');
  assert.equal(existsSync(helperMarker), false);

  writeFileSync(userPath, '{invalid json');
  const paths = runCli(repo, home, ['config', 'path', '--output=json'], env);
  assert.equal(paths.code, 0, paths.stdout + paths.stderr);
  const pathOutput = JSON.parse(paths.stdout);
  assert.equal(pathOutput.data.paths.user.path, userPath);
  assert.equal(pathOutput.data.paths.user.exists, true);
  assert.equal(
    pathOutput.data.paths.project.path,
    join(realpathSync(repo), '.aicommit.config.json'),
  );

  const invalid = runCli(repo, home, ['config', 'validate', '--output=json'], env);
  assert.equal(invalid.code, 2, invalid.stdout + invalid.stderr);
  assert.match(JSON.parse(invalid.stdout).error.message, /Failed to parse user config/);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /environment-secret-must-not-be-read/);
});
