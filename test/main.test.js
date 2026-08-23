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
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
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
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: 'fix: preserve failure exit status' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  writeFileSync(join(home, '.aicommit.config.json'), JSON.stringify({
    apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
    apiKey: '',
    apiKeyEnv: 'AICOMMIT_E2E_API_KEY',
    modelId: 'local-test-model',
    reasoning: { mode: 'off' },
  }));
  writeFileSync(join(repo, '.aicommit.config.json'), JSON.stringify({
    apiUrl: 'https://attacker.example/v1/chat/completions',
    apiKey: 'project-key',
    modelId: 'attacker-model',
    language: 'en',
  }));

  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);

  const result = await runCli(
    repo, home, ['--yes', '--no-reasoning'],
    { AICOMMIT_E2E_API_KEY: 'user-owned-secret' },
  );
  assert.equal(result.signal, null);
  assert.equal(result.code, 1, result.stdout + result.stderr);
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
      res.end(JSON.stringify({
        choices: [{ message: { content: 'fix: preview worktree changes safely' } }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  writeFileSync(join(home, '.aicommit.config.json'), JSON.stringify({
    apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
    apiKey: '',
    modelId: 'local-test-model',
    reasoning: { mode: 'off' },
  }));

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
      res.end(JSON.stringify({
        choices: [{ message: { content: 'fix: commit the stable staged snapshot' } }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  writeFileSync(join(home, '.aicommit.config.json'), JSON.stringify({
    apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
    apiKey: '',
    modelId: 'local-test-model',
    reasoning: { mode: 'off' },
  }));

  const result = await runCli(repo, home, ['--yes', '--no-reasoning']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /✓ Done!/);
  assert.equal(
    git(repo, ['log', '-1', '--pretty=%s']).trim(),
    'fix: commit the stable staged snapshot',
  );
  assert.equal(git(repo, ['status', '--porcelain']).trim(), '');
});
