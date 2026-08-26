import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  gitCredentialQuery,
  isLoopbackEndpoint,
  readGitCredential,
  resolveCredential,
} from '../src/credentials.js';

const config = (extra = {}) => ({
  apiUrl: 'https://api.example.test/v1/chat/completions',
  apiKey: '',
  apiKeyEnv: '',
  credentialHelper: { enabled: false, username: 'aicommit' },
  ...extra,
});

test('Git credential protocol query scopes lookup to endpoint and username', () => {
  assert.equal(
    gitCredentialQuery('https://api.example.test:8443/v1/chat/completions', 'robot'),
    [
      'protocol=https',
      'host=api.example.test:8443',
      'path=v1/chat/completions',
      'username=robot',
      '',
      '',
    ].join('\n'),
  );
  assert.throws(
    () => gitCredentialQuery('https://api.example.test/v1', 'robot\npassword=injected'),
    /control characters/,
  );
});

test('readGitCredential parses only the password from helper output', () => {
  let invocation;
  const apiKey = readGitCredential('https://api.example.test/v1', 'robot', (...args) => {
    invocation = args;
    return 'protocol=https\nhost=api.example.test\nusername=robot\npassword=helper-secret\n\n';
  });
  assert.equal(apiKey, 'helper-secret');
  assert.deepEqual(invocation.slice(0, 2), ['git', ['credential', 'fill']]);
  assert.match(invocation[2].input, /username=robot/);
  assert.equal(invocation[2].env.GIT_TERMINAL_PROMPT, '0');
});

test('credential resolution prefers env, then helper, then plaintext config', () => {
  let helperCalls = 0;
  const fromEnv = resolveCredential(
    config({
      apiKey: 'plaintext-secret',
      apiKeyEnv: 'AICOMMIT_TEST_KEY',
      credentialHelper: { enabled: true, username: 'robot' },
    }),
    {
      env: { AICOMMIT_TEST_KEY: 'env-secret' },
      readCredential() {
        helperCalls++;
        return 'helper-secret';
      },
    },
  );
  assert.equal(fromEnv.apiKey, 'env-secret');
  assert.equal(fromEnv.source, 'environment');
  assert.equal(helperCalls, 0);

  const fromHelper = resolveCredential(
    config({
      apiKey: 'plaintext-secret',
      credentialHelper: { enabled: true, username: 'robot' },
    }),
    { env: {}, readCredential: () => 'helper-secret' },
  );
  assert.equal(fromHelper.apiKey, 'helper-secret');
  assert.equal(fromHelper.source, 'credential-helper');

  const fromConfig = resolveCredential(config({ apiKey: 'plaintext-secret' }), { env: {} });
  assert.equal(fromConfig.apiKey, 'plaintext-secret');
  assert.equal(fromConfig.source, 'config');
  assert.match(fromConfig.warning, /plaintext/);
});

test('keyless loopback works while missing configured remote credentials fail', () => {
  const local = resolveCredential(
    config({ apiUrl: 'http://127.0.0.1:11434/api/chat', apiKeyEnv: 'MISSING' }),
    { env: {} },
  );
  assert.equal(local.apiKey, '');
  assert.equal(local.source, 'keyless-local');
  assert.equal(isLoopbackEndpoint('http://localhost:11434/v1'), true);
  assert.equal(isLoopbackEndpoint('https://api.example.test/v1'), false);

  assert.throws(
    () => resolveCredential(config({ apiKeyEnv: 'MISSING' }), { env: {} }),
    /Environment variable "MISSING"/,
  );
  assert.throws(
    () =>
      resolveCredential(config({ credentialHelper: { enabled: true, username: 'robot' } }), {
        env: {},
        readCredential: () => null,
      }),
    /Credential helper failed/,
  );

  const sensitiveEndpoint =
    'https://url-user:url-password@api.example.test/v1?api_key=query-secret#fragment-secret';
  assert.throws(
    () =>
      resolveCredential(
        config({
          apiUrl: sensitiveEndpoint,
          credentialHelper: { enabled: true, username: 'robot' },
        }),
        { env: {}, readCredential: () => null },
      ),
    (error) => {
      assert.match(error.message, /Credential helper failed/);
      assert.doesNotMatch(error.message, /url-user|url-password|query-secret|fragment-secret/);
      return true;
    },
  );
});

test('credential metadata never contains the resolved secret', () => {
  const resolved = resolveCredential(config({ apiKeyEnv: 'AICOMMIT_TEST_KEY' }), {
    env: { AICOMMIT_TEST_KEY: 'top-secret-value' },
  });
  assert.equal(
    JSON.stringify({ ...resolved, apiKey: '[redacted]' }).includes('top-secret-value'),
    false,
  );
  assert.equal(resolved.sourceLabel, 'env:AICOMMIT_TEST_KEY');
});
