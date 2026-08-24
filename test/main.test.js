import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function runCli(cwd, home, args, extraEnv = {}) {
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
      stdio: ['ignore', 'pipe', 'pipe'],
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
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      apiKey: '',
      apiKeyEnv: 'AICOMMIT_E2E_API_KEY',
      modelId: 'local-test-model',
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
    }),
  );

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
  assert.match(result.stderr, /Ignored unsafe settings from untrusted project config/);
  assert.match(result.stdout, new RegExp(`Endpoint: http://127\\.0\\.0\\.1:${port}`));
  assert.match(result.stdout, /Git commit failed/);
  assert.equal(git(repo, ['log', '-1', '--pretty=%s']).trim(), 'init');
  assert.match(git(repo, ['diff', '--staged']), /value = 2/);
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

test('single-file --split --yes keeps split semantics and stages the worktree change', async (t) => {
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
      reasoning: { mode: 'off' },
    }),
  );

  const result = await runCli(repo, home, ['--split', '--yes', '--no-reasoning']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Split plan: 1 commit/);
  assert.equal(git(repo, ['log', '-1', '--pretty=%s']).trim(), 'fix: commit one split file');
  assert.equal(git(repo, ['status', '--porcelain']).trim(), '');
});

test('--split --yes scans complete untracked files before auto-staging', async (t) => {
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
      reasoning: { mode: 'off' },
    }),
  );

  const result = await runCli(repo, home, ['--split', '--yes', '--no-reasoning']);
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
      reasoning: { mode: 'off' },
    }),
  );

  const result = await runCli(repo, home, [
    '--split',
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
