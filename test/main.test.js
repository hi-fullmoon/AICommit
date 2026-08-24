import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.match(result.stdout, /Context: recent commits:1/);
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

test('single-file --split=all --yes keeps split semantics and stages the worktree change', async (t) => {
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

  const result = await runCli(repo, home, ['--split=all', '--yes', '--no-reasoning']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Split plan: 1 commit/);
  assert.equal(git(repo, ['log', '-1', '--pretty=%s']).trim(), 'fix: commit one split file');
  assert.equal(git(repo, ['status', '--porcelain']).trim(), '');
});

test('--split=staged commits the index snapshot and leaves newer worktree edits unstaged', async (t) => {
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
      reasoning: { mode: 'off' },
    }),
  );

  const result = await runCli(repo, home, ['--split=staged', '--yes', '--no-reasoning']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /split scope: staged/);
  assert.equal(git(repo, ['rev-list', '--count', 'HEAD']).trim(), '3');
  assert.equal(git(repo, ['show', 'HEAD:app.js']), 'export const value = 2;\n');
  assert.equal(readFileSync(join(repo, 'app.js'), 'utf8'), 'export const value = 3;\n');
  assert.equal(git(repo, ['diff', '--cached']).trim(), '');
  assert.match(git(repo, ['diff']), /\+export const value = 3/);
  assert.match(git(repo, ['status', '--porcelain']), /^ M app\.js$/m);
});

test('--split=all --yes scans complete untracked files before auto-staging', async (t) => {
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

  const result = await runCli(repo, home, ['--split=all', '--yes', '--no-reasoning']);
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
      reasoning: { mode: 'off' },
    }),
  );

  const result = await runCli(repo, home, [
    '--split=all',
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
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
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
});
