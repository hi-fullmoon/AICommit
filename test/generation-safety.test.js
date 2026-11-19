import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';

import { assertCompleteResponse, buildCommitMessages } from '../src/api.js';
import { createAnalysisBudget, estimateTokens } from '../src/analysis-budget.js';
import { decodeUntrustedData } from '../src/trust.js';
import { normalizeCommitPolicy, validateCommitCandidate } from '../src/policy.js';

const source = readFileSync(new URL('../src/api.js', import.meta.url), 'utf8');
const config = { language: 'en', prompt: '', temperature: 0.3, regenerateWithDiff: false };

function envelopes(messages) {
  return [
    ...messages[1].content.matchAll(
      /BEGIN_AICOMMIT_UNTRUSTED_JSON\n[^\n]*\nEND_AICOMMIT_UNTRUSTED_JSON/g,
    ),
  ].map((match) => decodeUntrustedData(match[0]));
}

test('rewrites retain bounded original evidence independently of the previous message', () => {
  const previous = 'fix: preserve retry behavior';
  const request = buildCommitMessages(config, source, 1, previous);
  const data = envelopes(request.messages);
  const evidence = data.find((item) => item.kind === 'change_evidence').content;
  assert.ok(Array.from(evidence).length <= 6000);
  assert.ok(evidence.startsWith(source.slice(0, 100)));
  assert.ok(evidence.endsWith(source.slice(-100)));
  assert.match(evidence, /middle omitted/);
  assert.equal(data.find((item) => item.kind === 'previous_message').content, previous);
  assert.match(request.messages[1].content, /Correct omissions or mistakes/);
});

test('rewrites shrink evidence to fit the complete analysis input budget', () => {
  const cfg = { ...config, largeChange: { chunkInputTokens: 1800 } };
  const request = buildCommitMessages(cfg, source, 1, 'fix: preserve retry behavior');
  assert.ok(estimateTokens(JSON.stringify(request.messages)) <= 1800);
  assert.ok(envelopes(request.messages).find((item) => item.kind === 'change_evidence').content);
});

test('small rewrite evidence and explicit full input remain intact', () => {
  const input = source.slice(0, 200);
  const previous = 'fix: preserve retry behavior';
  const bounded = buildCommitMessages(config, input, 1, previous);
  assert.equal(envelopes(bounded.messages)[0].content, input);
  const full = buildCommitMessages({ ...config, regenerateWithDiff: true }, source, 1, previous);
  assert.equal(envelopes(full.messages).find((item) => item.kind === 'git_diff').content, source);
  assert.equal(
    envelopes(full.messages).find((item) => item.kind === 'previous_message').content,
    previous,
  );
});

test('rewrites refuse an input budget that cannot hold policy and evidence', () => {
  assert.throws(
    () =>
      buildCommitMessages(
        { ...config, largeChange: { chunkInputTokens: 1024 } },
        source,
        1,
        'fix: preserve retry behavior',
      ),
    (error) => error.category === 'config' && /do not fit/.test(error.message),
  );
});

test('a valid commit prefix cannot make a truncated response safe to accept', () => {
  const content = 'fix: preserve retry behavior\n\nHandle network';
  assert.equal(
    validateCommitCandidate(content, { policy: normalizeCommitPolicy({}, 'en') }).valid,
    true,
  );
  for (const finishReason of ['length', 'max_tokens', 'max_output_tokens', 'token_limit']) {
    assert.throws(
      () => assertCompleteResponse({ content, finishReason }),
      (error) =>
        error.category === 'response_format' &&
        error.code === 'response_truncated' &&
        error.data.partialMessage === content,
    );
  }
  assert.doesNotThrow(() => assertCompleteResponse({ content, finishReason: 'stop' }));
});

test('new rounds renew expired deadlines while preserving cumulative token limits', async () => {
  const budget = createAnalysisBudget({
    timeoutMs: 20,
    chunkInputTokens: 100,
    maxTotalTokens: 300,
  });
  budget.reserve(50, 50);
  const expired = budget.signal;
  await setTimeout(40);
  assert.equal(expired.aborted, true);
  assert.throws(() => budget.reserve(1, 1), /time budget/);
  budget.endRound();
  const paused = budget.snapshot();
  await setTimeout(40);
  assert.equal(budget.snapshot().elapsedMs, paused.elapsedMs);
  budget.startRound();
  assert.equal(budget.signal.aborted, false);
  assert.notEqual(budget.signal, expired);
  budget.reserve(50, 50);
  budget.endRound();
  assert.equal(budget.snapshot().requests, 2);
  assert.equal(budget.snapshot().budgetedTokens, 200);
  budget.startRound();
  assert.throws(() => budget.reserve(51, 50), /tokens budget/);
  budget.endRound();
});
