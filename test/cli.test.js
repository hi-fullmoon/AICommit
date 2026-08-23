import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../src/cli.js';

test('parseArgs recognizes dry-run in normal and split modes', () => {
  const normal = parseArgs(['--dry-run', '/tmp/repo']);
  assert.equal(normal.dryRun, true);
  assert.equal(normal.split, false);
  assert.equal(normal.targetPath, '/tmp/repo');

  const split = parseArgs(['--split', '--dry-run']);
  assert.equal(split.dryRun, true);
  assert.equal(split.split, true);
});

test('parseArgs keeps dry-run disabled by default and for setup', () => {
  assert.equal(parseArgs([]).dryRun, false);
  assert.equal(parseArgs(['setup']).dryRun, false);
  assert.equal(parseArgs(['setup']).yes, false);
});

test('parseArgs recognizes explicit non-interactive confirmation', () => {
  assert.equal(parseArgs(['--yes']).yes, true);
  assert.equal(parseArgs(['-y', '--split']).yes, true);
  assert.equal(parseArgs(['--yes', '--dry-run']).dryRun, true);
  assert.equal(parseArgs([]).yes, false);
});

test('parseArgs accepts reasoning levels and the disable alias', () => {
  assert.equal(parseArgs(['--reasoning=low']).cliReasoning, 'low');
  assert.equal(parseArgs(['--reasoning', 'high']).cliReasoning, 'high');
  assert.equal(parseArgs(['--reasoning=xhigh']).cliReasoning, 'xhigh');
  assert.equal(parseArgs(['--no-reasoning']).cliReasoning, 'off');
  assert.equal(parseArgs([]).cliReasoning, null);
});
