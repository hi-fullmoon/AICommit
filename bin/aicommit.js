#!/usr/bin/env node

import chalk from 'chalk';

import { nodeSupported, MIN_NODE_VERSION } from '../src/runtime.js';
import { sanitizeTerminalText } from '../src/utils.js';
import { classifyError } from '../src/errors.js';
import { errorOutput, isJsonOutputRequested, successOutput } from '../src/output.js';

const jsonOutput = isJsonOutputRequested();
if (jsonOutput) {
  // Keep stdout as a strict one-object machine channel. Existing progress UI
  // remains useful diagnostics, but is redirected to stderr in JSON mode.
  console.log = console.error;
}

try {
  if (!nodeSupported())
    throw new Error(
      `AICommit requires Node.js >=${MIN_NODE_VERSION}; current version is ${process.versions.node}.`,
    );
  const { main } = await import('../src/main.js');
  const result = await main();
  if (jsonOutput) process.stdout.write(`${JSON.stringify(successOutput(result))}\n`);
} catch (err) {
  const classified = classifyError(err);
  if (!classified.reported) {
    console.error(
      '\n  ' + chalk.red(`✗ ${sanitizeTerminalText(classified.message || classified)}\n`),
    );
  }
  if (jsonOutput) process.stdout.write(`${JSON.stringify(errorOutput(classified))}\n`);
  process.exitCode = classified.exitCode;
}
