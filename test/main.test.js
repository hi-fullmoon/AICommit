import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderTeamPolicyTemplate } from '../src/team-policy.js';

const CLI = fileURLToPath(new URL('../bin/aicommit.js', import.meta.url));

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function makeRepo(root) {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'app.js'), 'export const value = 1;\n');
  git(repo, ['add', 'app.js']);
  git(repo, ['commit', '-qm', 'init']);
  writeFileSync(join(repo, 'app.js'), 'export const value = 2;\n');
  git(repo, ['add', 'app.js']);
  return repo;
}

function runCli(cwd, home, args, extraEnv = {}, input = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(input || '');
  });
}

test('CLI ignores project connection overrides and returns failure for a rejected commit', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-main-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  const requests = [];

  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'fix: preserve failure exit status' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  writeFileSync(
    join(home, '.aicommit.config.json'),
    JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions?api-version=1&api_key=endpoint-query-secret#endpoint-fragment-secret`,
      apiKey: '',
      apiKeyEnv: 'AICOMMIT_E2E_API_KEY',
      modelId: 'local-test-model',
      language: 'en',
      reasoning: { mode: 'off' },
    }),
  );
  writeFileSync(
    join(repo, '.aicommit.config.json'),
    JSON.stringify({
      apiUrl: 'https://attacker.example/v1/chat/completions',
      apiKey: 'project-key',
      modelId: 'attacker-model',
      language: 'en',
      repositoryContext: {
        maxChars: 999999,
        conventions: { trustedFiles: ['ATTACKER.md'] },
      },
    }),
  );
  writeFileSync(join(repo, 'ATTACKER.md'), 'API_KEY=project-context-secret\n');

  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);

  const result = await runCli(repo, home, ['--yes', '--no-reasoning'], {
    AICOMMIT_E2E_API_KEY: 'user-owned-secret',
  });
  assert.equal(result.signal, null);
  assert.equal(result.code, 3, result.stdout + result.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.authorization, 'Bearer user-owned-secret');
  assert.equal(requests[0].body.model, 'local-test-model');
  assert.doesNotMatch(JSON.stringify(requests[0].body), /project-context-secret|ATTACKER\.md/);
  assert.match(result.stderr, /Ignored unsafe settings from untrusted project config/);
  assert.match(result.stdout, new RegExp(`Endpoint: http://127\\.0\\.0\\.1:${port}`));
  assert.match(result.stdout, /api-version=1/);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /endpoint-query-secret|endpoint-fragment-secret/,
  );
  assert.match(result.stdout, /Context: recent commits:1/);
  assert.match(result.stdout, /Git commit failed/);
  assert.equal(git(repo, ['log', '-1', '--pretty=%s']).trim(), 'init');
  assert.match(git(repo, ['diff', '--staged']), /value = 2/);
});

test('repository team policy cannot be overridden with --lang', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-team-language-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  writeFileSync(
    join(home, '.aicommit.config.json'),
    JSON.stringify({
      apiUrl: 'http://127.0.0.1:9/v1/chat/completions',
      apiKey: '',
      modelId: 'offline-model',
      reasoning: { mode: 'off' },
    }),
  );
  writeFileSync(join(repo, '.aicommit.policy.json'), renderTeamPolicyTemplate());

  const result = await runCli(repo, home, ['--lang=zh', '--yes', '--no-reasoning']);
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /--lang cannot override the repository team policy/);
  assert.equal(git(repo, ['log', '-1', '--pretty=%s']).trim(), 'init');
  assert.match(git(repo, ['diff', '--staged']), /value = 2/);
});

test('credential helper failures redact endpoint secrets in text and doctor JSON output', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-credential-error-redaction-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  const gitConfig = join(root, 'empty-gitconfig');
  writeFileSync(gitConfig, '');
  writeFileSync(
    join(home, '.aicommit.config.json'),
    JSON.stringify({
      apiUrl:
        'https://url-user:url-password@provider.example/v1?api_key=query-secret#fragment-secret',
      apiKey: '',
      modelId: 'offline-model',
      language: 'en',
      credentialHelper: { enabled: true, username: 'redaction-test' },
      reasoning: { mode: 'off' },
    }),
  );
  const isolatedGit = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitConfig,
  };

  const textResult = await runCli(repo, home, ['--yes', '--no-reasoning'], isolatedGit);
  const jsonResult = await runCli(repo, home, ['doctor', '--output=json'], isolatedGit);
  assert.equal(textResult.code, 2, textResult.stdout + textResult.stderr);
  assert.equal(jsonResult.code, 2, jsonResult.stdout + jsonResult.stderr);
  const jsonOutput = JSON.parse(jsonResult.stdout);
  assert.equal(jsonOutput.error.category, 'config');
  assert.match(jsonOutput.error.message, /Credential helper failed/);
  const rendered = textResult.stdout + textResult.stderr + jsonResult.stdout + jsonResult.stderr;
  assert.doesNotMatch(rendered, /url-user|url-password|query-secret|fragment-secret/);
});

test('non-interactive dry run restores staging performed by aicommit', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-dry-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  git(repo, ['reset', '-q']);

  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'fix: preview worktree changes safely' } }],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  writeFileSync(
    join(home, '.aicommit.config.json'),
    JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      apiKey: '',
      modelId: 'local-test-model',
      language: 'en',
      reasoning: { mode: 'off' },
    }),
  );

  const result = await runCli(repo, home, ['--yes', '--dry-run', '--no-reasoning']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(requests, 1);
  assert.match(result.stdout, /tool-owned staging was restored/);
  assert.equal(git(repo, ['diff', '--staged']).trim(), '');
  assert.match(git(repo, ['diff']), /value = 2/);
  assert.equal(git(repo, ['log', '-1', '--pretty=%s']).trim(), 'init');
});

test('interactive cancellation returns through cleanup and records a cancelled metric', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  git(repo, ['reset', '-q']);
  writeFileSync(
    join(home, '.aicommit.config.json'),
    JSON.stringify({
      apiUrl: 'http://127.0.0.1:9/v1/chat/completions',
      apiKey: '',
      modelId: 'offline-model',
      language: 'en',
      reasoning: { mode: 'off' },
    }),
  );

  const result = await runCli(repo, home, ['--no-reasoning'], {}, 'jj\n');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Cancelled — stage files with git add/);
  assert.equal(git(repo, ['diff', '--staged']).trim(), '');
  assert.match(git(repo, ['diff']), /value = 2/);

  const metrics = readFileSync(join(home, '.aicommit', 'metrics.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(metrics.at(-1).result, 'cancelled');
});

test('interactive split scope cancellation returns without contacting the provider', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-split-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  writeFileSync(
    join(home, '.aicommit.config.json'),
    JSON.stringify({
      apiUrl: 'http://127.0.0.1:9/v1/chat/completions',
      apiKey: '',
      modelId: 'offline-model',
      language: 'en',
      reasoning: { mode: 'off' },
    }),
  );

  const result = await runCli(repo, home, ['split', 'run', '--no-reasoning'], {}, 'jj\n');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Split cancelled/);
  assert.match(git(repo, ['diff', '--staged']), /value = 2/);
  assert.equal(git(repo, ['log', '-1', '--pretty=%s']).trim(), 'init');

  const metrics = readFileSync(join(home, '.aicommit', 'metrics.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(metrics.at(-1).result, 'cancelled');
});

test('non-interactive single-commit flow creates the reviewed staged snapshot', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-success-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);

  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'fix: commit the stable staged snapshot' } }],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  writeFileSync(
    join(home, '.aicommit.config.json'),
    JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      apiKey: '',
      modelId: 'local-test-model',
      language: 'en',
      reasoning: { mode: 'off' },
    }),
  );

  const result = await runCli(repo, home, ['--yes', '--no-reasoning']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /✓ Done!/);
  assert.equal(
    git(repo, ['log', '-1', '--pretty=%s']).trim(),
    'fix: commit the stable staged snapshot',
  );
  assert.equal(git(repo, ['status', '--porcelain']).trim(), '');
});

test('interactive flow treats an existing staged snapshot as final without another scope prompt', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-staged-intent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  writeFileSync(join(repo, 'later.js'), 'export const later = true;\n');

  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'fix: commit only the staged intent' } }],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  writeFileSync(
    join(home, '.aicommit.config.json'),
    JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      apiKey: '',
      modelId: 'local-test-model',
      language: 'en',
      reasoning: { mode: 'off' },
    }),
  );

  const result = await runCli(repo, home, ['--no-reasoning'], {}, '\n');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(
    git(repo, ['log', '-1', '--pretty=%s']).trim(),
    'fix: commit only the staged intent',
  );
  assert.equal(git(repo, ['show', '--name-only', '--pretty=', 'HEAD']).trim(), 'app.js');
  assert.match(git(repo, ['status', '--porcelain']), /^\?\? later\.js$/m);
});

test('single-file split run --scope=all keeps split semantics and stages the worktree change', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-split-one-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  git(repo, ['reset', '-q']);

  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    subject: 'fix: commit one split file',
                    files: ['app.js'],
                  },
                ]),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  writeFileSync(
    join(home, '.aicommit.config.json'),
    JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      apiKey: '',
      modelId: 'local-test-model',
      language: 'en',
      reasoning: { mode: 'off' },
    }),
  );

  const result = await runCli(repo, home, [
    'split',
    'run',
    '--scope=all',
    '--yes',
    '--no-reasoning',
  ]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Split plan: 1 commit/);
  assert.equal(git(repo, ['log', '-1', '--pretty=%s']).trim(), 'fix: commit one split file');
  assert.equal(git(repo, ['status', '--porcelain']).trim(), '');
});

test('split run --scope=staged commits the index snapshot and leaves newer edits unstaged', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-split-staged-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  writeFileSync(join(repo, 'extra.js'), 'export const extra = true;\n');
  git(repo, ['add', 'extra.js']);
  writeFileSync(join(repo, 'app.js'), 'export const value = 3;\n');

  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify([
                  { subject: 'fix: commit staged app snapshot', files: ['app.js'] },
                  { subject: 'feat: add staged extra module', files: ['extra.js'] },
                ]),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  writeFileSync(
    join(home, '.aicommit.config.json'),
    JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      apiKey: '',
      modelId: 'local-test-model',
      language: 'en',
      reasoning: { mode: 'off' },
    }),
  );

  const result = await runCli(repo, home, [
    'split',
    'run',
    '--scope=staged',
    '--yes',
    '--no-reasoning',
  ]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /split scope: staged/);
  assert.equal(git(repo, ['rev-list', '--count', 'HEAD']).trim(), '3');
  assert.equal(git(repo, ['show', 'HEAD:app.js']), 'export const value = 2;\n');
  assert.equal(readFileSync(join(repo, 'app.js'), 'utf8'), 'export const value = 3;\n');
  assert.equal(git(repo, ['diff', '--cached']).trim(), '');
  assert.match(git(repo, ['diff']), /\+export const value = 3/);
  assert.match(git(repo, ['status', '--porcelain']), /^ M app\.js$/m);
});

test('experimental hunk plan/apply creates lossless same-file commits without provider reuse', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-split-hunks-e2e-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  git(repo, ['reset', '--hard', '-q', 'HEAD']);
  const original = Array.from(
    { length: 30 },
    (_, index) => `export const value${index + 1} = ${index + 1};`,
  );
  writeFileSync(join(repo, 'app.js'), original.join('\n') + '\n');
  git(repo, ['add', 'app.js']);
  git(repo, ['commit', '-qm', 'build baseline']);
  const changed = [...original];
  changed[1] = 'export const firstFeature = true;';
  changed[26] = 'export const secondFeature = true;';
  writeFileSync(join(repo, 'app.js'), changed.join('\n') + '\n');

  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      assert.match(body, /H1/);
      assert.match(body, /H2/);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    subject: 'feat: add first feature',
                    files: [],
                    hunks: [{ path: 'app.js', ids: ['H1'] }],
                  },
                  {
                    subject: 'feat: add second feature',
                    files: [],
                    hunks: [{ path: 'app.js', ids: ['H2'] }],
                  },
                ]),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const configPath = join(home, '.aicommit.config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      apiKey: '',
      modelId: 'local-test-model',
      language: 'en',
      reasoning: { mode: 'off' },
    }),
  );

  const planPath = join(root, 'hunk-plan.json');
  const planned = await runCli(repo, home, [
    'split',
    'plan',
    '--scope=all',
    '--split-hunks',
    `--file=${planPath}`,
    '--yes',
    '--no-reasoning',
  ]);
  assert.equal(planned.code, 0, planned.stdout + planned.stderr);
  assert.match(planned.stdout, /\[H1\]/);
  assert.match(planned.stdout, /\[H2\]/);
  const artifact = JSON.parse(readFileSync(planPath, 'utf8'));
  assert.equal(artifact.hunkMode, true);
  assert.equal(artifact.groups[0].hunks[0].ids[0], 'H1');
  assert.doesNotMatch(JSON.stringify(artifact), /firstFeature|secondFeature|diff --git/);

  rmSync(configPath);
  const applied = await runCli(repo, home, ['split', 'apply', `--file=${planPath}`, '--yes']);
  assert.equal(applied.code, 0, applied.stdout + applied.stderr);
  const firstCommit = git(repo, ['show', 'HEAD~1:app.js']);
  assert.match(firstCommit, /firstFeature/);
  assert.doesNotMatch(firstCommit, /secondFeature/);
  assert.equal(git(repo, ['show', 'HEAD:app.js']), changed.join('\n') + '\n');
  assert.equal(git(repo, ['status', '--porcelain']), '');
});

test('split plan exports JSON and split apply commits it without provider configuration', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-split-plan-apply-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  writeFileSync(join(repo, 'extra.js'), 'export const extra = true;\n');
  git(repo, ['add', 'extra.js']);
  const planPath = join(root, 'plans', 'split.json');

  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify([
                  { subject: 'fix: apply planned app change', files: ['app.js'] },
                  { subject: 'feat: apply planned extra module', files: ['extra.js'] },
                ]),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const configPath = join(home, '.aicommit.config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      apiKey: '',
      modelId: 'local-test-model',
      language: 'en',
      reasoning: { mode: 'off' },
    }),
  );

  const planned = await runCli(repo, home, [
    'split',
    'plan',
    '--scope=staged',
    `--file=${planPath}`,
    '--yes',
    '--no-reasoning',
  ]);
  assert.equal(planned.code, 0, planned.stdout + planned.stderr);
  assert.match(planned.stdout, /Split plan written/);
  assert.equal(git(repo, ['rev-list', '--count', 'HEAD']).trim(), '1');
  const artifact = JSON.parse(readFileSync(planPath, 'utf8'));
  assert.equal(artifact.kind, 'aicommit-split-plan');
  assert.equal(artifact.scope, 'staged');
  assert.equal(artifact.groups.length, 2);
  assert.ok(!Object.hasOwn(artifact, 'diff'));

  rmSync(configPath);
  const applied = await runCli(repo, home, ['split', 'apply', `--file=${planPath}`, '--yes']);
  assert.equal(applied.code, 0, applied.stdout + applied.stderr);
  assert.match(applied.stdout, /Loaded split plan/);
  assert.equal(git(repo, ['rev-list', '--count', 'HEAD']).trim(), '3');
  assert.equal(git(repo, ['status', '--porcelain']).trim(), '');
});

test('split resume finishes a checkpointed apply without provider configuration', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-split-resume-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  writeFileSync(join(repo, 'extra.js'), 'export const extra = true;\n');
  git(repo, ['add', 'extra.js']);
  const planPath = join(root, 'split.json');

  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify([
                  { subject: 'fix: checkpoint app change', files: ['app.js'] },
                  { subject: 'feat: checkpoint extra module', files: ['extra.js'] },
                ]),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const configPath = join(home, '.aicommit.config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      apiKey: '',
      modelId: 'local-test-model',
      language: 'en',
      reasoning: { mode: 'off' },
    }),
  );
  const planned = await runCli(repo, home, [
    'split',
    'plan',
    '--scope=staged',
    `--file=${planPath}`,
    '--yes',
    '--no-reasoning',
  ]);
  assert.equal(planned.code, 0, planned.stdout + planned.stderr);

  rmSync(configPath);
  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  writeFileSync(
    hook,
    '#!/bin/sh\nif test "$(git diff --cached --name-only)" = "extra.js"; then exit 1; fi\n',
  );
  chmodSync(hook, 0o755);
  const interrupted = await runCli(repo, home, ['split', 'apply', `--file=${planPath}`, '--yes']);
  assert.equal(interrupted.code, 3, interrupted.stdout + interrupted.stderr);
  assert.match(interrupted.stdout, /Completed: 1 checkpointed commit/);
  assert.match(interrupted.stdout, /Current worktree\/index status/);
  assert.equal(git(repo, ['rev-list', '--count', 'HEAD']).trim(), '2');

  rmSync(hook);
  const resumed = await runCli(repo, home, ['split', 'resume', '--yes']);
  assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
  assert.match(resumed.stdout, /1 completed, 1 pending/);
  assert.match(resumed.stdout, /Resume complete/);
  assert.equal(
    git(repo, ['log', '--reverse', '--format=%s']).trim(),
    'init\nfix: checkpoint app change\nfeat: checkpoint extra module',
  );
  assert.equal(git(repo, ['status', '--porcelain']).trim(), '');
});

test('split apply rejects a stale fingerprint before mutating the index', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-split-plan-stale-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  const planPath = join(root, 'split.json');

  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify([
                  { subject: 'fix: retain planned snapshot', files: ['app.js'] },
                ]),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const configPath = join(home, '.aicommit.config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      apiKey: '',
      modelId: 'local-test-model',
      language: 'en',
      reasoning: { mode: 'off' },
    }),
  );
  const planned = await runCli(repo, home, [
    'split',
    'plan',
    '--scope=staged',
    `--file=${planPath}`,
    '--yes',
    '--no-reasoning',
  ]);
  assert.equal(planned.code, 0, planned.stdout + planned.stderr);

  writeFileSync(join(repo, 'app.js'), 'export const value = 99;\n');
  git(repo, ['add', 'app.js']);
  const indexBefore = git(repo, ['diff', '--cached', '--binary', '--full-index']);
  rmSync(configPath);
  const applied = await runCli(repo, home, ['split', 'apply', `--file=${planPath}`, '--yes']);
  assert.equal(applied.code, 8, applied.stdout + applied.stderr);
  assert.match(applied.stderr, /no longer matches/);
  assert.equal(git(repo, ['rev-list', '--count', 'HEAD']).trim(), '1');
  assert.equal(git(repo, ['diff', '--cached', '--binary', '--full-index']), indexBefore);
});

test('split plan rejects output inside the working tree before a provider request', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-split-plan-location-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    req.resume();
    res.writeHead(500);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  writeFileSync(
    join(home, '.aicommit.config.json'),
    JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      apiKey: '',
      modelId: 'local-test-model',
      language: 'en',
      reasoning: { mode: 'off' },
    }),
  );

  const result = await runCli(repo, home, [
    'split',
    'plan',
    '--scope=staged',
    `--file=${join(repo, 'plan.json')}`,
    '--yes',
    '--no-reasoning',
  ]);
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.equal(requests, 0);
  assert.match(result.stderr, /outside the working tree or inside the repository Git directory/);
});

test('split run --scope=all scans complete untracked files before auto-staging', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-split-sensitive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  writeFileSync(
    join(repo, 'notes.txt'),
    'ordinary notes\n'.repeat(200) + 'API_KEY=must-not-be-committed\n',
  );

  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    req.resume();
    res.writeHead(500);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  writeFileSync(
    join(home, '.aicommit.config.json'),
    JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      apiKey: '',
      modelId: 'local-test-model',
      language: 'en',
      reasoning: { mode: 'off' },
    }),
  );

  const result = await runCli(repo, home, [
    'split',
    'run',
    '--scope=all',
    '--yes',
    '--no-reasoning',
  ]);
  assert.equal(result.code, 7, result.stdout + result.stderr);
  assert.equal(requests, 0);
  assert.match(result.stdout, /will not auto-stage sensitive files/);
  assert.equal(git(repo, ['log', '-1', '--pretty=%s']).trim(), 'init');
  assert.match(git(repo, ['status', '--porcelain']), /notes\.txt/);
});

test('--output=json emits one decoration-free success object and keeps diagnostics on stderr', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-json-success-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);

  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'local-test-model-v2',
          choices: [
            {
              message: {
                content: 'fix: expose stable machine output',
                reasoning_content: 'private reasoning must not enter JSON',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  writeFileSync(
    join(home, '.aicommit.config.json'),
    JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      apiKey: '',
      modelId: 'local-test-model',
      language: 'en',
      reasoning: { mode: 'off' },
    }),
  );

  const result = await runCli(repo, home, ['--yes', '--no-reasoning', '--output=json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.message, 'fix: expose stable machine output');
  assert.equal(output.provider, 'custom');
  assert.equal(output.model, 'local-test-model');
  assert.equal(output.exitReason, 'success');
  assert.equal(output.committed, true);
  assert.deepEqual(output.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.ok(!Object.hasOwn(output, 'reasoning'));
  assert.ok(!Object.hasOwn(output, 'diff'));
  assert.doesNotMatch(result.stdout, /private reasoning|AI-powered|Calling/);
  assert.match(result.stderr, /AI-powered commit message generator/);
  assert.equal(git(repo, ['log', '-1', '--pretty=%s']).trim(), 'fix: expose stable machine output');
  const metricText = readFileSync(join(home, '.aicommit', 'metrics.jsonl'), 'utf8');
  const metric = JSON.parse(metricText.trim());
  assert.deepEqual(Object.keys(metric), ['durationMs', 'usage', 'result', 'edited', 'rewrites']);
  assert.equal(metric.result, 'committed');
  assert.equal(metric.edited, false);
  assert.equal(metric.rewrites, 0);
  assert.deepEqual(metric.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.doesNotMatch(
    metricText,
    /stable machine output|private reasoning|app\.js|local-test-model|custom/,
  );
});

test('automatic policy correction is counted as a privacy-safe rewrite metric', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-policy-correction-metric-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  let calls = 0;

  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: calls === 1 ? 'Updated the application value' : 'fix: update app value',
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  writeFileSync(
    join(home, '.aicommit.config.json'),
    JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      apiKey: '',
      modelId: 'local-test-model',
      language: 'en',
      reasoning: { mode: 'off' },
    }),
  );

  const result = await runCli(repo, home, ['--yes', '--no-reasoning']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(calls, 2);
  const metricText = readFileSync(join(home, '.aicommit', 'metrics.jsonl'), 'utf8');
  const metric = JSON.parse(metricText.trim());
  assert.equal(metric.rewrites, 1);
  assert.equal(metric.edited, false);
  assert.doesNotMatch(metricText, /application value|app\.js|local-test-model/);
});

test('stats command reports local trends without requiring a Git repository', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-stats-e2e-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const metricsPath = join(home, 'quality.jsonl');
  writeFileSync(
    join(home, '.aicommit.config.json'),
    JSON.stringify({ metrics: { enabled: true, path: metricsPath, maxEntries: 20 } }),
  );
  writeFileSync(
    metricsPath,
    JSON.stringify({
      durationMs: 250,
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      result: 'committed',
      edited: false,
      rewrites: 0,
    }) + '\n',
  );

  const result = await runCli(root, home, ['stats']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Local quality stats/);
  assert.match(result.stdout, /First pass:\s+1 \(100\.0%\)/);
  assert.match(result.stdout, /Tokens:\s+total 25/);
  assert.match(result.stdout, /local only; no messages, diffs, reasoning/);
  assert.equal(readFileSync(metricsPath, 'utf8').trim().split('\n').length, 1);
});

test('--output=json returns the split plan without reasoning or terminal decoration', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-json-split-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  writeFileSync(join(repo, 'extra.js'), 'export const extra = true;\n');
  git(repo, ['add', 'extra.js']);

  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify([
                  { subject: 'fix: update app value', files: ['app.js'] },
                  { subject: 'feat: add extra module', files: ['extra.js'] },
                ]),
                reasoning_content: 'private split reasoning',
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  writeFileSync(
    join(home, '.aicommit.config.json'),
    JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      apiKey: '',
      modelId: 'local-test-model',
      language: 'en',
      reasoning: { mode: 'off' },
    }),
  );

  const result = await runCli(repo, home, [
    'split',
    'run',
    '--scope=all',
    '--yes',
    '--dry-run',
    '--no-reasoning',
    '--output=json',
  ]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.message, null);
  assert.equal(output.plan.length, 2);
  assert.deepEqual(
    output.plan.map((group) => group.message),
    ['fix: update app value', 'feat: add extra module'],
  );
  assert.doesNotMatch(result.stdout, /private split reasoning|Split plan|AI-powered/);
  assert.match(result.stderr, /Split plan: 2 commits/);
});

test('configuration failures use exit code 2 in text and JSON modes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-json-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);

  const textResult = await runCli(repo, home, ['--unknown-option']);
  const jsonResult = await runCli(repo, home, ['--output=json', '--unknown-option']);
  assert.equal(textResult.code, 2, textResult.stdout + textResult.stderr);
  assert.equal(jsonResult.code, 2, jsonResult.stdout + jsonResult.stderr);
  const output = JSON.parse(jsonResult.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.exitReason, 'config');
  assert.equal(output.error.category, 'config');
  assert.doesNotMatch(jsonResult.stdout, /AI-powered|✗|\u001b/);
  assert.match(jsonResult.stderr, /Unknown option:/);
});

test('provider and response-format errors have stable JSON categories and exit codes', async (t) => {
  async function runFailure(responseBody, status = 200) {
    const root = mkdtempSync(join(tmpdir(), 'aicommit-json-error-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    mkdirSync(home);
    const repo = makeRepo(root);
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(responseBody);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const { port } = server.address();
    writeFileSync(
      join(home, '.aicommit.config.json'),
      JSON.stringify({
        apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
        apiKey: '',
        modelId: 'local-test-model',
        language: 'en',
        reasoning: { mode: 'off' },
        retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      }),
    );
    return runCli(repo, home, ['--yes', '--no-reasoning', '--output=json']);
  }

  const provider = await runFailure('bad key', 401);
  assert.equal(provider.code, 5, provider.stdout + provider.stderr);
  assert.equal(JSON.parse(provider.stdout).error.category, 'provider');

  const format = await runFailure('{not-json');
  assert.equal(format.code, 6, format.stdout + format.stderr);
  assert.equal(JSON.parse(format.stdout).error.category, 'response_format');
});

test('clean repositories return a git_state JSON error with exit code 3', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-json-clean-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  writeFileSync(join(repo, 'app.js'), 'export const value = 1;\n');
  git(repo, ['add', 'app.js']);

  const result = await runCli(repo, home, ['--yes', '--output=json']);
  assert.equal(result.code, 3, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.exitReason, 'git_state');
  assert.equal(output.error.category, 'git_state');
});

test('doctor checks runtime, config, capabilities, credentials, and connectivity without leaking keys', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aicommit-doctor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(root);
  let authorization = null;

  const server = createServer((req, res) => {
    authorization = req.headers.authorization;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'doctor-model-v2',
          choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  writeFileSync(
    join(home, '.aicommit.config.json'),
    JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions?api_key=doctor-url-secret&api-version=1#doctor-fragment-secret`,
      apiKey: 'legacy-plaintext-must-not-win',
      apiKeyEnv: 'AICOMMIT_DOCTOR_KEY',
      modelId: 'doctor-model',
      reasoning: { mode: 'off' },
    }),
  );

  const result = await runCli(repo, home, ['doctor', '--output=json'], {
    AICOMMIT_DOCTOR_KEY: 'doctor-secret-value',
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.exitReason, 'doctor_ok');
  assert.equal(output.provider, 'custom');
  assert.equal(output.model, 'doctor-model');
  assert.deepEqual(output.usage, { inputTokens: 4, outputTokens: 1, totalTokens: 5 });
  assert.equal(authorization, 'Bearer doctor-secret-value');
  for (const label of [
    'Node.js:',
    'Git:',
    'Config:',
    'Endpoint security:',
    'Provider capabilities:',
    'Credentials: env:AICOMMIT_DOCTOR_KEY',
    'Connectivity:',
  ]) {
    assert.match(result.stderr, new RegExp(label));
  }
  assert.doesNotMatch(result.stdout + result.stderr, /doctor-secret-value/);
  assert.doesNotMatch(result.stdout + result.stderr, /legacy-plaintext-must-not-win/);
  assert.doesNotMatch(result.stdout + result.stderr, /doctor-url-secret|doctor-fragment-secret/);
  assert.match(result.stderr, /api-version=1/);
});
