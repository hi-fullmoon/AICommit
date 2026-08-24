#!/usr/bin/env node

import chalk from 'chalk';

import { main } from '../src/main.js';
import { sanitizeTerminalText } from '../src/utils.js';
import { classifyError } from '../src/errors.js';
import { errorOutput, isJsonOutputRequested, successOutput } from '../src/output.js';
import { recordMetric } from '../src/metrics.js';

const jsonOutput = isJsonOutputRequested();
const runStartedAt = performance.now();
if (jsonOutput) {
  // Keep stdout as a strict one-object machine channel. Existing progress UI
  // remains useful diagnostics, but is redirected to stderr in JSON mode.
  console.log = console.error;
}

try {
  const result = await main();
  await recordMetric({
    durationMs: result?.latencyMs ?? performance.now() - runStartedAt,
    usage: result?.usage,
    result: result?.committed ? 'committed' : result?.exitReason || 'success',
    edited: result?.edited,
    rewrites: result?.rewrites,
  }).catch((err) => console.error(`  ⚠ Failed to write local metrics: ${err.message}`));
  if (jsonOutput) process.stdout.write(`${JSON.stringify(successOutput(result))}\n`);
} catch (err) {
  const classified = classifyError(err);
  if (!classified.reported) {
    console.error(
      '\n  ' + chalk.red(`✗ ${sanitizeTerminalText(classified.message || classified)}\n`),
    );
  }
  await recordMetric({
    durationMs: performance.now() - runStartedAt,
    usage: null,
    result: classified.category,
    edited: false,
    rewrites: 0,
  }).catch((metricError) =>
    console.error(`  ⚠ Failed to write local metrics: ${metricError.message}`),
  );
  if (jsonOutput) process.stdout.write(`${JSON.stringify(errorOutput(classified))}\n`);
  process.exitCode = classified.exitCode;
}
