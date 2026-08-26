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

  const abort = parseArgs(['split', '--abort', '--yes']);
  assert.equal(abort.splitCommand, 'abort');
  assert.equal(abort.splitPlanFile, null);
  assert.throws(
    () => parseArgs(['split', '--abort', '--file=x']),
    /accepts only --yes, --output, and --debug/,
  );
});

test('parseArgs keeps experimental hunk splitting opt-in and scoped to planning', () => {
  assert.equal(parseArgs(['--split=staged']).splitHunks, false);
  const direct = parseArgs(['--split=all', '--split-hunks']);
  assert.equal(direct.splitHunks, true);
  const exported = parseArgs([
    'split',
    'plan',
    '--scope=staged',
    '--split-hunks',
    '--file=plan.json',
  ]);
  assert.equal(exported.splitHunks, true);
  assert.throws(() => parseArgs(['--split-hunks']), /requires --split/);
  assert.throws(
    () => parseArgs(['split', 'apply', '--file=plan.json', '--split-hunks']),
    /requires --split/,
  );
  assert.throws(
    () => parseArgs(['split', '--resume', '--split-hunks']),
    /requires --split|accepts only/,
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

test('parseArgs recognizes config inspection and shell completion commands', () => {
  const show = parseArgs(['config', 'show', '/tmp/repo', '--provider=local', '--output=json']);
  assert.equal(show.configAction, 'show');
  assert.equal(show.targetPath, '/tmp/repo');
  assert.equal(show.cliProvider, 'local');
  assert.equal(show.output, 'json');
  assert.equal(parseArgs(['config', 'validate']).configAction, 'validate');
  assert.equal(parseArgs(['config', 'path']).configAction, 'path');
  assert.throws(() => parseArgs(['config']), /show, validate, or path/);
  assert.throws(() => parseArgs(['config', 'path', '--provider=x']), /does not accept/);
  assert.throws(() => parseArgs(['config', 'show', '--yes']), /config accepts only/);

  assert.equal(parseArgs(['completion', 'bash']).completionShell, 'bash');
  assert.equal(parseArgs(['completion', 'zsh']).completionShell, 'zsh');
  assert.equal(parseArgs(['completion', 'fish']).completionShell, 'fish');
  assert.throws(() => parseArgs(['completion']), /requires one shell/);
  assert.throws(() => parseArgs(['completion', 'powershell']), /bash, zsh, or fish/);
});

test('parseArgs recognizes team policy template and check inputs', () => {
  assert.equal(parseArgs(['policy', 'template']).policyAction, 'template');
  const file = parseArgs(['policy', 'check', '--file=.git/COMMIT_EDITMSG', '--output=json']);
  assert.equal(file.policyAction, 'check');
  assert.equal(file.policyMessageFile, '.git/COMMIT_EDITMSG');
  assert.equal(file.output, 'json');
  const range = parseArgs(['policy', 'check', '/tmp/repo', '--range=main..HEAD']);
  assert.equal(range.targetPath, '/tmp/repo');
  assert.equal(range.policyRange, 'main..HEAD');
  assert.throws(() => parseArgs(['policy']), /template or check/);
  assert.throws(() => parseArgs(['policy', 'template', '--output=json']), /takes no arguments/);
  assert.throws(
    () => parseArgs(['policy', 'check', '--file=message', '--range=HEAD']),
    /either --file or --range/,
  );
  assert.throws(() => parseArgs(['--range=HEAD']), /only valid with/);
  assert.throws(() => parseArgs(['policy', 'check', '--provider=x']), /policy check accepts only/);
});

test('parseArgs recognizes provider preset inspection and lifecycle commands', () => {
  assert.equal(parseArgs(['preset', 'show', '--output=json']).presetAction, 'show');
  assert.equal(parseArgs(['preset', 'validate']).presetAction, 'validate');
  assert.equal(parseArgs(['preset', 'path']).presetAction, 'path');
  const install = parseArgs(['preset', 'install', '--file=next.json']);
  assert.equal(install.presetAction, 'install');
  assert.equal(install.presetFile, 'next.json');
  assert.equal(parseArgs(['preset', 'rollback']).presetAction, 'rollback');
  assert.throws(() => parseArgs(['preset']), /show, validate, path, install, or rollback/);
  assert.throws(() => parseArgs(['preset', 'install']), /requires --file/);
  assert.throws(() => parseArgs(['preset', 'show', '--file=x']), /only valid with preset/);
  assert.throws(() => parseArgs(['preset', 'show', '/tmp/repo']), /preset accepts only/);
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
