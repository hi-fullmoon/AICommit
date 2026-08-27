import chalk from 'chalk';
import ora from 'ora';

import { startReasoningStream } from './ui.js';

// Run one provider task with the shared spinner, streamed-reasoning, and
// Ctrl+C lifecycle used by both normal and split commit flows. Callers keep
// ownership of retries and error presentation because those policies differ.
export async function runModelTask({
  spinnerText,
  reasoning,
  machineOutput = false,
  cancelMessage,
  failureMessage,
  successMessage,
  task,
}) {
  const spinner = ora({ text: chalk.dim(spinnerText), color: 'cyan' }).start();
  let liveReasoning;
  const stream =
    reasoning?.mode === 'on' && !machineOutput
      ? {
          onReasoningDelta(chunk) {
            if (!liveReasoning) {
              spinner.stop();
              liveReasoning = startReasoningStream(reasoning.maxDisplayChars, chunk);
              return;
            }
            liveReasoning.append(chunk);
          },
        }
      : null;

  const cancelOnSigint = () => {
    spinner.stop();
    console.log(chalk.dim(`\n  ${cancelMessage}\n`));
    process.exit(130); // 128 + SIGINT
  };
  process.on('SIGINT', cancelOnSigint);

  try {
    const result = await task(stream);
    if (liveReasoning) await liveReasoning.stop();
    spinner.succeed(successMessage(result));
    return result;
  } catch (err) {
    if (liveReasoning) await liveReasoning.stop();
    spinner.fail(chalk.red(failureMessage));
    throw err;
  } finally {
    process.removeListener('SIGINT', cancelOnSigint);
  }
}
