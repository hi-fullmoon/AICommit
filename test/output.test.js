import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AicommitError, classifyError, ERROR_CATEGORIES, EXIT_CODES } from '../src/errors.js';
import { errorOutput, successOutput } from '../src/output.js';

const schema = JSON.parse(
  await readFile(new URL('../schemas/aicommit-output.schema.json', import.meta.url), 'utf8'),
);

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object')
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}

// The output schema only needs a compact subset of JSON Schema. Keeping this
// validator in the contract test avoids adding a runtime dependency merely
// to verify our own fixed schema artifact.
function validate(value, definition, path = '$') {
  if ('const' in definition) assert.deepEqual(value, definition.const, `${path}: const`);
  if (definition.enum) assert.ok(definition.enum.includes(value), `${path}: enum`);
  if (definition.type) {
    const types = Array.isArray(definition.type) ? definition.type : [definition.type];
    assert.ok(
      types.some((type) => matchesType(value, type)),
      `${path}: type ${types.join('|')}`,
    );
  }
  if (typeof value === 'string' && definition.minLength !== undefined) {
    assert.ok(value.length >= definition.minLength, `${path}: minLength`);
  }
  if (typeof value === 'number' && definition.minimum !== undefined) {
    assert.ok(value >= definition.minimum, `${path}: minimum`);
  }
  if (Array.isArray(value) && definition.items) {
    value.forEach((item, index) => validate(item, definition.items, `${path}[${index}]`));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of definition.required || []) {
      assert.ok(Object.hasOwn(value, key), `${path}: missing ${key}`);
    }
    if (definition.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(Object.hasOwn(definition.properties || {}, key), `${path}: extra ${key}`);
      }
    }
    for (const [key, child] of Object.entries(definition.properties || {})) {
      if (Object.hasOwn(value, key)) validate(value[key], child, `${path}.${key}`);
    }
  }
}

test('success and error machine outputs validate against the published JSON schema', () => {
  const success = successOutput({
    message: 'feat: expose JSON output',
    provider: 'openai',
    model: 'gpt-test',
    latencyMs: 12.5,
    usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, vendorField: 9 },
    warnings: ['diff condensed'],
    committed: true,
    data: { configValid: true },
  });
  const error = errorOutput(new AicommitError(ERROR_CATEGORIES.NETWORK, 'socket reset'));

  validate(success, schema);
  validate(error, schema);
  assert.equal(success.error, null);
  assert.deepEqual(success.data, { configValid: true });
  assert.equal(error.exitReason, 'network');
  assert.ok(!Object.hasOwn(success, 'reasoning'));
  assert.ok(!Object.hasOwn(success, 'diff'));
});

test('machine plan output exposes only messages and file assignments', () => {
  const output = successOutput({
    plan: [{ message: 'fix: first', files: ['a.js'], reasoning: 'private trace' }],
    exitReason: 'dry_run',
  });
  validate(output, schema);
  assert.deepEqual(output.plan, [{ message: 'fix: first', files: ['a.js'] }]);
});

test('machine plan output exposes hunk identifiers without patch content', () => {
  const output = successOutput({
    plan: [
      {
        message: 'fix: selected hunk',
        files: [],
        hunks: [{ path: 'app.js', ids: ['H1'] }],
        patch: 'private code',
      },
    ],
  });
  assert.deepEqual(output.plan, [
    {
      message: 'fix: selected hunk',
      files: [],
      hunks: [{ path: 'app.js', ids: ['H1'] }],
    },
  ]);
  assert.doesNotMatch(JSON.stringify(output), /private code|patch/);
});

test('error classification has stable categories and exit codes', () => {
  const cases = [
    [new Error('Invalid config "apiUrl"'), ERROR_CATEGORIES.CONFIG, 2],
    [new Error('Not a git repository'), ERROR_CATEGORIES.GIT_STATE, 3],
    [new TypeError('fetch failed'), ERROR_CATEGORIES.NETWORK, 4],
    [new Error('HTTP 401: bad key'), ERROR_CATEGORIES.PROVIDER, 5],
    [new Error('Provider returned invalid JSON'), ERROR_CATEGORIES.RESPONSE_FORMAT, 6],
    [
      new AicommitError(ERROR_CATEGORIES.SENSITIVE_DATA, 'blocked'),
      ERROR_CATEGORIES.SENSITIVE_DATA,
      7,
    ],
    [
      new AicommitError(ERROR_CATEGORIES.CONCURRENT_MODIFICATION, 'changed'),
      ERROR_CATEGORIES.CONCURRENT_MODIFICATION,
      8,
    ],
  ];

  for (const [input, category, exitCode] of cases) {
    const classified = classifyError(input);
    assert.equal(classified.category, category);
    assert.equal(classified.exitCode, exitCode);
    assert.equal(EXIT_CODES[category], exitCode);
  }
});
