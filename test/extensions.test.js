import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createExtensionHost,
  EXTENSION_HOST,
  isExtensionProviderType,
  validateExtensionsConfig,
} from '../src/extensions.js';
import { generateCommitMessage } from '../src/api.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const nodeMajor = Number(process.versions.node.split('.')[0]);

async function extensionFixture({ credentials = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'aicommit-extension-'));
  const packageRoot = join(root, 'fixture');
  await mkdir(packageRoot);
  const secretPath = join(root, 'secret.txt');
  await writeFile(secretPath, 'credential-from-disk');
  const entry = join(packageRoot, 'index.mjs');
  await writeFile(
    entry,
    `import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
export async function contextProvider(input) {
  let disk = 'denied';
  let write = 'denied';
  let child = 'denied';
  try { disk = readFileSync(${JSON.stringify(secretPath)}, 'utf8'); } catch {}
  try { writeFileSync(${JSON.stringify(join(packageRoot, 'escaped.txt'))}, 'bad'); write = 'allowed'; } catch {}
  try { execFileSync(process.execPath, ['--version']); child = 'allowed'; } catch {}
  return {
    text: 'files=' + input.files.length + ';env=' + (process.env.AICOMMIT_EXTENSION_TEST_SECRET || 'denied') + ';disk=' + disk + ';write=' + write + ';child=' + child,
    warnings: ['fixture warning']
  };
}
export function messageValidator({ message }) {
  return { issues: message.includes('ticket-') ? [] : [{ severity: 'error', code: 'ticket', message: 'ticket id required' }] };
}
export function providerAdapter({ operation, config, request, response, reasoning }) {
  if ('apiKey' in config) throw new Error('credential leaked to adapter');
  if (operation === 'buildRequest') {
    if (config.modelId === 'leaky') return { apiKey: 'bad' };
    if (config.modelId === 'token-leaky') return { token: 'bad' };
    return { model: config.modelId, messages: request.messages, max_tokens: request.maxTokens, adapted: true, observedUrl: config.apiUrl };
  }
  if (operation === 'normalizeResponse') return { content: response.answer, model: response.model, usage: { totalTokens: 3 }, finishReason: 'stop' };
  if (operation === 'reasoningForFollowUp') return { ...reasoning, mode: 'off' };
  throw new Error('unknown operation');
}
`,
  );
  const manifestPath = join(packageRoot, 'aicommit-extension.json');
  await writeFile(
    manifestPath,
    JSON.stringify({
      kind: 'aicommit-extension',
      apiVersion: 1,
      id: 'fixture',
      version: '1.0.0',
      entry: './index.mjs',
      capabilities: ['contextProvider', 'messageValidator', 'providerAdapter'],
      permissions: { credentials },
    }),
  );
  return { root, manifestPath, entry };
}

function settings(manifests = []) {
  return { manifests, timeoutMs: 3000, maxContextChars: 1000 };
}

test('extension config and provider ids are strict and project-safe by shape', () => {
  const value = settings();
  assert.equal(validateExtensionsConfig(value), value);
  assert.equal(isExtensionProviderType('extension:team-validator'), true);
  assert.equal(isExtensionProviderType('extension:../escape'), false);
  assert.throws(
    () => validateExtensionsConfig({ ...settings(), manifests: ['relative.json'] }),
    /absolute manifest paths/,
  );
  assert.throws(() => validateExtensionsConfig({ ...settings(), unknown: true }), /unknown field/);
});

test('extension manifests cannot request credential access', async () => {
  const fixture = await extensionFixture({ credentials: true });
  try {
    await assert.rejects(
      () => createExtensionHost(settings([fixture.manifestPath])),
      /credentials/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test(
  'isolated extensions provide context, validation, and provider adaptation without credentials',
  { skip: nodeMajor < 20 },
  async () => {
    const fixture = await extensionFixture();
    const previousSecret = process.env.AICOMMIT_EXTENSION_TEST_SECRET;
    const realFetch = globalThis.fetch;
    process.env.AICOMMIT_EXTENSION_TEST_SECRET = 'credential-from-env';
    try {
      const host = await createExtensionHost(settings([fixture.manifestPath]));
      assert.deepEqual(host.extensions, [
        {
          id: 'fixture',
          version: '1.0.0',
          capabilities: ['contextProvider', 'messageValidator', 'providerAdapter'],
        },
      ]);
      const context = await host.collectContext({
        branch: 'main',
        files: [{ status: 'M', path: 'src/app.js' }],
      });
      assert.match(context.text, /files=1;env=denied;disk=denied;write=denied;child=denied/);
      assert.deepEqual(context.warnings, ['[extension:fixture] fixture warning']);

      assert.deepEqual(await host.validateMessage('feat: change', { version: 1 }), [
        {
          severity: 'error',
          code: 'extension:fixture:ticket',
          message: '[extension:fixture] ticket id required',
        },
      ]);
      assert.deepEqual(await host.validateMessage('feat: ticket-123 change', { version: 1 }), []);

      const adapter = host.providerAdapter({
        providerType: 'extension:fixture',
        apiUrl: 'https://provider.example/v1',
        apiKey: 'must-not-cross-boundary',
        modelId: 'fixture-model',
        extraBody: {},
        reasoning: { mode: 'on' },
      });
      assert.equal(adapter.id, 'extension:fixture');
      assert.deepEqual(
        await adapter.buildRequest({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 9 }),
        {
          model: 'fixture-model',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 9,
          adapted: true,
          observedUrl: 'https://provider.example/v1',
        },
      );
      const normalized = await adapter.normalizeResponse({ answer: 'OK', model: 'fixture-model' });
      assert.equal(normalized.content, 'OK');
      assert.equal(normalized.raw.answer, 'OK');
      assert.equal((await adapter.reasoningForFollowUp({ mode: 'on' })).mode, 'off');
      const leakyAdapter = host.providerAdapter({
        providerType: 'extension:fixture',
        apiUrl: 'https://provider.example/v1',
        apiKey: 'must-not-cross-boundary',
        modelId: 'leaky',
        extraBody: {},
        reasoning: { mode: 'off' },
      });
      await assert.rejects(
        () => leakyAdapter.buildRequest({ messages: [], maxTokens: 1 }),
        /credential-like request field/,
      );
      const tokenLeakyAdapter = host.providerAdapter({
        providerType: 'extension:fixture',
        apiUrl: 'https://provider.example/v1',
        apiKey: 'must-not-cross-boundary',
        modelId: 'token-leaky',
        extraBody: {},
        reasoning: { mode: 'off' },
      });
      await assert.rejects(
        () => tokenLeakyAdapter.buildRequest({ messages: [], maxTokens: 1 }),
        /credential-like request field/,
      );

      const sanitizedUrlAdapter = host.providerAdapter({
        providerType: 'extension:fixture',
        apiUrl:
          'https://url-user:url-password@provider.example/v1?api-version=1&api_key=url-query-secret#url-fragment-secret',
        apiKey: 'must-not-cross-boundary',
        modelId: 'fixture-model',
        extraBody: {},
        reasoning: { mode: 'off' },
      });
      const sanitizedPayload = await sanitizedUrlAdapter.buildRequest({
        messages: [],
        maxTokens: 1,
      });
      assert.match(sanitizedPayload.observedUrl, /api-version=1/);
      assert.doesNotMatch(
        sanitizedPayload.observedUrl,
        /url-user|url-password|url-query-secret|url-fragment-secret/,
      );

      for (const credentialConfig of [
        { extraBody: { api_key: 'body-secret' }, reasoning: { mode: 'off' } },
        {
          extraBody: {},
          reasoning: { mode: 'on', enabledBody: { authorization: 'reasoning-secret' } },
        },
      ]) {
        const credentialAdapter = host.providerAdapter({
          providerType: 'extension:fixture',
          apiUrl: 'https://provider.example/v1',
          apiKey: 'must-not-cross-boundary',
          modelId: 'fixture-model',
          ...credentialConfig,
        });
        await assert.rejects(
          () => credentialAdapter.buildRequest({ messages: [], maxTokens: 1 }),
          /credential-like field.*extension boundary/,
        );
      }
      await assert.rejects(
        () =>
          adapter.buildRequest({
            messages: [],
            maxTokens: 1,
            extraBody: { client_secret: 'request-secret' },
          }),
        /credential-like field.*extension boundary/,
      );

      let calls = 0;
      globalThis.fetch = async (_url, options) => {
        calls += 1;
        assert.equal(options.headers.Authorization, 'Bearer must-not-cross-boundary');
        const body = JSON.parse(options.body);
        assert.equal(body.adapted, true);
        return new Response(
          JSON.stringify({
            answer: calls === 1 ? 'feat: change' : 'feat: ticket-123 change',
            model: 'fixture-model',
          }),
          { status: 200 },
        );
      };
      const runtimeConfig = {
        ...DEFAULT_CONFIG,
        language: 'en',
        apiUrl: 'https://provider.example/v1',
        apiKey: 'must-not-cross-boundary',
        modelId: 'fixture-model',
        providerType: 'extension:fixture',
        reasoning: { ...DEFAULT_CONFIG.reasoning, mode: 'off' },
      };
      Object.defineProperty(runtimeConfig, EXTENSION_HOST, { value: host, enumerable: true });
      const generated = await generateCommitMessage(
        runtimeConfig,
        'diff --git a/app.js b/app.js\n+const changed = true;',
      );
      assert.equal(generated.message, 'feat: ticket-123 change');
      assert.equal(generated.corrections, 1);
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = realFetch;
      if (previousSecret === undefined) delete process.env.AICOMMIT_EXTENSION_TEST_SECRET;
      else process.env.AICOMMIT_EXTENSION_TEST_SECRET = previousSecret;
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test('message validators fail closed on execution timeout', { skip: nodeMajor < 20 }, async () => {
  const fixture = await extensionFixture();
  try {
    await writeFile(
      fixture.entry,
      `export async function messageValidator() {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return { issues: [] };
}`,
    );
    const host = await createExtensionHost({
      manifests: [fixture.manifestPath],
      timeoutMs: 100,
      maxContextChars: 1000,
    });
    await assert.rejects(
      () => host.validateMessage('feat: change', { version: 1 }),
      /timed out after 100ms/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
