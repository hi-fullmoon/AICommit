import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runModelTask } from '../src/generation-ui.js';

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
