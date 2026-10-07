import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);
const runner = fileURLToPath(
  new URL('../test-support/request-environment-check.js', import.meta.url),
);

test('real HTTP transport isolates SDK environment headers and logs', async () => {
  const received = [];
  // Reject authentication instead of fabricating a model generation response.
  const server = createServer((request, response) => {
    received.push(request.headers);
    request.resume();
    response.writeHead(401);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const providerType of ['custom', 'openrouter']) {
      const config = {
        apiUrl: `http://127.0.0.1:${server.address().port}/chat/completions`,
        providerType,
        modelId: 'unlisted-model',
        ...(providerType === 'openrouter' ? { apiKey: 'application-owned-key' } : {}),
        timeoutMs: 1000,
      };
      const result = await run(process.execPath, [runner, JSON.stringify(config)], {
        env: {
          ...process.env,
          OPENAI_ORG_ID: 'environment-org',
          OPENAI_PROJECT_ID: 'environment-project',
          OPENAI_CUSTOM_HEADERS:
            'X-Environment-Credential: environment-secret\nContent-Type: text/plain\nX-Title: environment-title',
          OPENAI_LOG: 'debug',
        },
        timeout: 5000,
      });
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      const headers = received.at(-1);
      assert.equal(headers['openai-organization'], undefined);
      assert.equal(headers['openai-project'], undefined);
      assert.equal(headers['x-environment-credential'], undefined);
      assert.equal(headers['content-type'], 'application/json');
      assert.equal(headers.authorization, config.apiKey ? `Bearer ${config.apiKey}` : undefined);
      assert.equal(headers['x-title'], providerType === 'openrouter' ? 'aicommit' : undefined);
    }
    assert.equal(received.length, 2);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
