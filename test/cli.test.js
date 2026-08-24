import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../src/cli.js';

test('parseArgs recognizes dry-run in normal and split modes', () => {
  const normal = parseArgs(['--dry-run', '/tmp/repo']);
  assert.equal(normal.dryRun, true);
  assert.equal(normal.split, null);
  assert.equal(normal.targetPath, '/tmp/repo');

  const split = parseArgs(['--split', '--dry-run']);
  assert.equal(split.dryRun, true);
  assert.equal(split.split, 'prompt');
});

test('parseArgs requires an explicit staged/all scope for non-interactive split', () => {
  assert.equal(parseArgs(['--split=staged', '--yes']).split, 'staged');
  assert.equal(parseArgs(['--split=all', '--yes']).split, 'all');
  assert.throws(() => parseArgs(['--split=other']), /Invalid split scope/);
  assert.throws(() => parseArgs(['--split', '--yes']), /requires an explicit scope/);
});

test('parseArgs recognizes split plan/apply artifact commands', () => {
  const plan = parseArgs([
    'split',
    'plan',
    '--scope=staged',
    '--file=.aicommit-plan.json',
    '--yes',
  ]);
  assert.equal(plan.splitCommand, 'plan');
  assert.equal(plan.split, 'staged');
  assert.equal(plan.splitPlanFile, '.aicommit-plan.json');
  assert.equal(plan.dryRun, true);

  const apply = parseArgs(['split', 'apply', '--file', 'plan.json', '--yes']);
  assert.equal(apply.splitCommand, 'apply');
  assert.equal(apply.split, null);
  assert.equal(apply.splitPlanFile, 'plan.json');
  assert.throws(() => parseArgs(['split', 'plan', '--scope=all']), /requires --file/);
  assert.throws(() => parseArgs(['split', 'apply', '--file=x', '--scope=all']), /reads its scope/);
  assert.throws(() => parseArgs(['split', 'unknown', '--file=x']), /plan, apply, or/);
  assert.throws(() => parseArgs(['--scope=all']), /only valid/);

  const resume = parseArgs(['split', '--resume', '--yes']);
  assert.equal(resume.splitCommand, 'resume');
  assert.equal(resume.splitPlanFile, null);
  assert.throws(
    () => parseArgs(['split', '--resume', '--file=x']),
    /accepts only --yes, --output, and --debug/,
  );
});

test('parseArgs keeps dry-run disabled by default and for setup', () => {
  assert.equal(parseArgs([]).dryRun, false);
  assert.equal(parseArgs(['setup']).dryRun, false);
  assert.equal(parseArgs(['setup']).yes, false);
});

test('parseArgs recognizes explicit non-interactive confirmation', () => {
  assert.equal(parseArgs(['--yes']).yes, true);
  assert.equal(parseArgs(['-y', '--split=all']).yes, true);
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

test('parseArgs accepts text and JSON output modes', () => {
  assert.equal(parseArgs([]).output, 'text');
  assert.equal(parseArgs(['--output=json', '--yes']).output, 'json');
  assert.equal(parseArgs(['--output', 'text']).output, 'text');
  assert.throws(() => parseArgs(['--output=yaml']), /Invalid output mode/);
});

test('parseArgs recognizes doctor and restricts it to diagnostic options', () => {
  const doctor = parseArgs(['doctor', '--provider=local', '--output=json']);
  assert.equal(doctor.doctor, true);
  assert.equal(doctor.cliProvider, 'local');
  assert.equal(doctor.output, 'json');
  assert.throws(() => parseArgs(['doctor', '--yes']), /doctor accepts only/);
  assert.equal(parseArgs([]).doctor, false);
});

test('parseArgs recognizes local metrics management actions', () => {
  assert.equal(parseArgs(['metrics']).metricsAction, 'status');
  assert.equal(parseArgs(['metrics', 'clear']).metricsAction, 'clear');
  assert.equal(parseArgs(['metrics', 'enable']).metricsAction, 'enable');
  assert.equal(parseArgs(['metrics', 'disable']).metricsAction, 'disable');
  assert.throws(() => parseArgs(['metrics', 'upload']), /metrics accepts one action/);
  assert.equal(parseArgs([]).metricsAction, null);
});

test('parseArgs recognizes local stats and its privacy-management aliases', () => {
  assert.equal(parseArgs(['stats']).statsAction, 'show');
  assert.equal(parseArgs(['stats', 'show']).statsAction, 'show');
  assert.equal(parseArgs(['stats', 'clear']).statsAction, 'clear');
  assert.equal(parseArgs(['stats', 'enable']).statsAction, 'enable');
  assert.equal(parseArgs(['stats', 'disable']).statsAction, 'disable');
  assert.throws(() => parseArgs(['stats', 'upload']), /stats accepts one action/);
  assert.equal(parseArgs([]).statsAction, null);
});
