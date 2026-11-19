import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

import { runModelTask } from '../src/generation-ui.js';
import { createAnalysisBudget } from '../src/analysis-budget.js';

test('reasoning stream follows provider auto mode while JSON and off modes stay private', async () => {
  for (const { mode, machineOutput, shouldStream } of [
    { mode: 'on', machineOutput: false, shouldStream: true },
    { mode: 'auto', machineOutput: false, shouldStream: true },
    { mode: 'off', machineOutput: false, shouldStream: false },
    { mode: 'on', machineOutput: true, shouldStream: false },
  ]) {
    let receivedStream = false;
    await runModelTask({
      spinnerText: 'Testing reasoning display',
      reasoning: { mode, maxDisplayChars: 1200 },
      machineOutput,
      cancelMessage: 'Cancelled',
      failureMessage: 'Failed',
      successMessage: () => 'Done',
      task: async (stream) => {
        receivedStream = Boolean(stream);
        stream?.onReasoningDelta('model thinking');
        return { reasoning: 'model thinking' };
      },
    });
    assert.equal(receivedStream, shouldStream, `${mode} / JSON=${machineOutput}`);
  }
});

test('task lifecycle pauses deadlines on success and failure without resetting spending', async () => {
  const budget = createAnalysisBudget({ timeoutMs: 1000, maxTotalTokens: 300 });
  const options = {
    spinnerText: 'Reading generation source',
    machineOutput: true,
    cancelMessage: 'Cancelled',
    failureMessage: 'Read failed',
    successMessage: () => 'Read complete',
    analysisBudget: budget,
  };
  const path = new URL('../src/generation-ui.js', import.meta.url);
  const task = async () => {
    budget.reserve(50, 50);
    return readFile(path, 'utf8');
  };
  assert.match(await runModelTask({ ...options, task }), /runModelTask/);
  const paused = budget.snapshot().elapsedMs;
  await setTimeout(20);
  assert.equal(budget.snapshot().elapsedMs, paused);
  await assert.rejects(
    runModelTask({
      ...options,
      task: async () => {
        budget.reserve(50, 50);
        return readFile(new URL('../src/does-not-exist.js', import.meta.url));
      },
    }),
    { code: 'ENOENT' },
  );
  const failed = budget.snapshot().elapsedMs;
  await setTimeout(20);
  assert.equal(budget.snapshot().elapsedMs, failed);
  assert.match(await runModelTask({ ...options, task }), /runModelTask/);
  assert.equal(budget.snapshot().budgetedTokens, 300);
  await assert.rejects(runModelTask({ ...options, task }), /tokens budget/);
});
