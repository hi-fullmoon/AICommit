import { requestGeneration } from '../src/model-client.js';

try {
  await requestGeneration(JSON.parse(process.argv[2]), {
    messages: [{ role: 'user', content: 'Check request environment isolation.' }],
    maxTokens: 16,
  });
  process.exitCode = 1;
} catch (error) {
  if (!error.message.startsWith('HTTP 401:')) throw error;
}
