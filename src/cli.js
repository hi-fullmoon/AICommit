import { createRequire } from 'node:module';

import chalk from 'chalk';

import { ERROR_CATEGORIES, fail } from './errors.js';

const _require = createRequire(import.meta.url);
const { version: VERSION } = _require('../package.json');

function showHelp() {
  console.log(`
  ${chalk.cyan.bold('aicommit')} — AI-powered git commit message generator

  ${chalk.bold('Usage:')}
    ${chalk.dim('$')} aicommit [path] [options]
    ${chalk.dim('$')} aicommit setup
    ${chalk.dim('$')} aicommit config <show|validate|path> [options]
    ${chalk.dim('$')} aicommit policy <template|check> [options]
    ${chalk.dim('$')} aicommit preset <show|validate|path|install|rollback> [options]
    ${chalk.dim('$')} aicommit completion <bash|zsh|fish>
    ${chalk.dim('$')} aicommit split <run|plan|apply|resume|abort> [options]

  ${chalk.bold('Commands:')}
    setup                 Interactive configuration wizard
    doctor                Diagnose runtime, config, credentials, and connectivity
    config show           Print the effective configuration with secrets redacted
    config validate       Parse, merge, and validate configuration without reading credentials
    config path           Print user, project, and team-policy paths
    policy template       Print a safe repository team-policy template
    policy check          Validate a message file or Git range with the effective team policy
    preset                Inspect, validate, install, or roll back provider preset manifests
    completion            Generate Bash, Zsh, or Fish completion on stdout
    split run             Plan and create logical commits
    split plan            Generate and export a fingerprinted JSON plan
    split apply           Validate and apply an exported JSON plan
    split resume          Resume the repository's unfinished transaction
    split abort           Discard recovery metadata; keep commits and changes
    stats [action]        Show quality/cost trends; show, clear, enable, disable

  ${chalk.bold('Arguments:')}
    path                  Target directory (default: current directory)

  ${chalk.bold('Options:')}
    -h, --help            Show this help message
    -v, --version         Show version number
    -l, --lang=<zh|en>    Commit message language (default: zh)
    -p, --provider=<name> Use the named provider from config "providers"
    --split-hunks         Experimental same-file hunk planning (default: off)
    --scope=<scope>       Scope for "split run|plan": staged, all
    --file=<path>         Split-plan artifact or commit-message file
    --range=<revision>    Git revision/range for "policy check" (default: HEAD)
    --reasoning=<level>   Set reasoning effort (enabled by default: medium)
    --no-reasoning        Explicitly disable reasoning when supported
    --dry-run             Generate and review without creating commits
    -y, --yes             Non-interactive: accept the generated message/plan
    --output=<text|json>  Output mode; JSON requires --yes for commit flows
    --debug               Print debug info (parsed args, final config, etc.)

  ${chalk.bold('Examples:')}
    aicommit setup        Run the interactive configuration wizard
    aicommit doctor       Check runtime, config, credentials, and connectivity
    aicommit config show  Show effective redacted configuration
    aicommit config validate --output=json  Validate configuration for CI
    aicommit config path  Show user and project config locations
    aicommit policy template > .aicommit.policy.json  Create a committable policy
    aicommit policy check --file=.git/COMMIT_EDITMSG  Validate a local commit message
    aicommit policy check --range=origin/main..HEAD --output=json  Validate a CI range
    aicommit preset show  Show the active versioned provider preset manifest
    aicommit preset install --file=provider-presets.json  Install a compatible manifest
    aicommit preset rollback  Restore the previously installed manifest
    aicommit completion zsh > _aicommit  Generate Zsh completion
    aicommit stats        Show local acceptance, quality, latency, and token trends
    aicommit              Commit changes in current directory (Chinese)
    aicommit --lang=en    Generate English commit message
    aicommit -p deepseek  Switch to the "deepseek" provider from config
    aicommit split run    Choose staged/all scope, then plan logical commits
    aicommit split run --scope=staged  Split only the reviewed index snapshot
    aicommit split run --scope=all --yes  Split the complete working tree non-interactively
    aicommit split run --scope=staged --split-hunks  Split eligible text hunks
    aicommit split plan --scope=staged --file=.aicommit-plan.json --yes
    aicommit split apply --file=.aicommit-plan.json --yes
    aicommit split resume --yes  Resume pending groups from the checkpoint
    aicommit split abort --yes  Discard a stale checkpoint without changing Git state
    aicommit --reasoning=low  Stream reasoning; Ctrl+O expands/collapses it
    aicommit --dry-run    Review a generated message without committing
    aicommit --yes        Commit already staged changes without prompts
    aicommit --yes --output=json  Emit one machine-readable result on stdout
    aicommit /path/to    Commit changes in the specified directory
`);
}

function showVersion() {
  console.log(`aicommit v${VERSION}`);
}

// Read the value for an option like -l/--lang or -p/--provider. The next
// argument must exist and must not be another flag — otherwise `-l -s`
// would silently swallow "-s" as the value.
function takeValue(args, i, arg, hint) {
  const next = args[i + 1];
  if (!next || next.startsWith('-')) {
    throw fail(ERROR_CATEGORIES.CONFIG, `Missing value for ${arg}. Use ${arg}=<${hint}>`);
  }
  return next;
}

function parsedDefaults(overrides = {}) {
  return {
    targetPath: null,
    cliLang: null,
    cliProvider: null,
    cliReasoning: null,
    output: 'text',
    debug: false,
    split: null,
    splitHunks: false,
    splitCommand: null,
    splitPlanFile: null,
    dryRun: false,
    yes: false,
    setup: false,
    doctor: false,
    configAction: null,
    policyAction: null,
    policyMessageFile: null,
    policyRange: null,
    presetAction: null,
    presetFile: null,
    completionShell: null,
    statsAction: null,
    help: false,
    version: false,
    ...overrides,
  };
}

export function parseArgs(args = process.argv.slice(2)) {
  // "setup" is a standalone subcommand — it doesn't combine with the
  // commit-flow options, so short-circuit before parsing them.
  if (args[0] === 'setup') {
    if (args.length > 1) {
      throw fail(
        ERROR_CATEGORIES.CONFIG,
        `"setup" takes no arguments — got: ${args.slice(1).join(' ')}`,
      );
    }
    return parsedDefaults({ setup: true });
  }

  if (args[0] === 'stats') {
    const action = args[1] || 'show';
    const allowed = ['show', 'clear', 'enable', 'disable'];
    if (args.length > 2 || !allowed.includes(action)) {
      throw fail(ERROR_CATEGORIES.CONFIG, `stats accepts one action: ${allowed.join(', ')}.`);
    }
    return parsedDefaults({ statsAction: action });
  }

  if (args[0] === 'completion') {
    const shell = args[1];
    if (args.length !== 2 || !['bash', 'zsh', 'fish'].includes(shell)) {
      throw fail(ERROR_CATEGORIES.CONFIG, 'completion requires one shell: bash, zsh, or fish.');
    }
    return parsedDefaults({ completionShell: shell });
  }

  if (args[0] === 'policy' && args[1] === 'template') {
    if (args.length !== 2) {
      throw fail(ERROR_CATEGORIES.CONFIG, 'policy template takes no arguments.');
    }
    return parsedDefaults({ policyAction: 'template' });
  }

  let policyAction = null;
  if (args[0] === 'policy') {
    policyAction = args[1];
    if (policyAction !== 'check') {
      throw fail(ERROR_CATEGORIES.CONFIG, 'policy requires one action: template or check.');
    }
    args = args.slice(2);
  }

  let presetAction = null;
  if (args[0] === 'preset') {
    presetAction = args[1];
    if (!['show', 'validate', 'path', 'install', 'rollback'].includes(presetAction)) {
      throw fail(
        ERROR_CATEGORIES.CONFIG,
        'preset requires one action: show, validate, path, install, or rollback.',
      );
    }
    args = args.slice(2);
  }

  let configAction = null;
  if (args[0] === 'config') {
    configAction = args[1];
    if (!['show', 'validate', 'path'].includes(configAction)) {
      throw fail(ERROR_CATEGORIES.CONFIG, 'config requires one action: show, validate, or path.');
    }
    args = args.slice(2);
  }

  let splitCommand = null;
  if (args[0] === 'split') {
    splitCommand = args[1];
    if (!['run', 'plan', 'apply', 'resume', 'abort'].includes(splitCommand)) {
      throw fail(
        ERROR_CATEGORIES.CONFIG,
        'split requires one action: run, plan, apply, resume, or abort.',
      );
    }
    args = args.slice(2);
  }

  const doctor = args[0] === 'doctor';
  if (doctor) args = args.slice(1);

  let targetPath = null;
  let cliLang = null;
  let cliProvider = null;
  let cliReasoning = null;
  let output = 'text';
  let debug = false;
  let split = null;
  let splitHunks = false;
  let splitPlanFile = null;
  let policyMessageFile = null;
  let policyRange = null;
  let presetFile = null;
  let splitScopeOption = false;
  let dryRun = false;
  let yes = false;
  const setup = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      showHelp();
      return parsedDefaults({ output, help: true });
    }

    if (arg === '-v' || arg === '--version') {
      showVersion();
      return parsedDefaults({ output, version: true });
    }

    if (arg === '--debug') {
      debug = true;
      continue;
    }

    if (arg === '--output') {
      output = takeValue(args, i, arg, 'text|json');
      i++;
      continue;
    }

    if (arg.startsWith('--output=')) {
      output = arg.slice('--output='.length);
      if (!output) throw fail(ERROR_CATEGORIES.CONFIG, 'Missing value for --output.');
      continue;
    }

    if (arg === '--split-hunks') {
      splitHunks = true;
      continue;
    }

    if (arg === '--scope') {
      splitScopeOption = true;
      split = takeValue(args, i, arg, 'staged|all');
      i++;
      if (!['staged', 'all'].includes(split)) {
        throw fail(ERROR_CATEGORIES.CONFIG, `Invalid split scope: "${split}". Use staged or all.`);
      }
      continue;
    }

    if (arg.startsWith('--scope=')) {
      splitScopeOption = true;
      split = arg.slice('--scope='.length);
      if (!['staged', 'all'].includes(split)) {
        throw fail(ERROR_CATEGORIES.CONFIG, `Invalid split scope: "${split}". Use staged or all.`);
      }
      continue;
    }

    if (arg === '--file') {
      const value = takeValue(args, i, arg, 'path');
      if (policyAction) policyMessageFile = value;
      else if (presetAction) presetFile = value;
      else splitPlanFile = value;
      i++;
      continue;
    }

    if (arg.startsWith('--file=')) {
      const value = arg.slice('--file='.length);
      if (!value) throw fail(ERROR_CATEGORIES.CONFIG, 'Missing value for --file.');
      if (policyAction) policyMessageFile = value;
      else if (presetAction) presetFile = value;
      else splitPlanFile = value;
      continue;
    }

    if (arg === '--range') {
      policyRange = takeValue(args, i, arg, 'revision');
      i++;
      continue;
    }

    if (arg.startsWith('--range=')) {
      policyRange = arg.slice('--range='.length);
      if (!policyRange) throw fail(ERROR_CATEGORIES.CONFIG, 'Missing value for --range.');
      continue;
    }

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg === '-y' || arg === '--yes') {
      yes = true;
      continue;
    }

    if (arg === '--reasoning') {
      cliReasoning = takeValue(args, i, arg, 'low|medium|high|xhigh|max');
      i++;
      continue;
    }

    if (arg.startsWith('--reasoning=')) {
      cliReasoning = arg.slice('--reasoning='.length);
      if (!cliReasoning) {
        throw fail(ERROR_CATEGORIES.CONFIG, 'Missing value for --reasoning.');
      }
      continue;
    }

    if (arg === '--no-reasoning') {
      cliReasoning = 'off';
      continue;
    }

    if (arg === '-l' || arg === '--lang') {
      cliLang = takeValue(args, i, arg, 'zh|en');
      i++;
      continue;
    }

    if (arg.startsWith('--lang=')) {
      cliLang = arg.slice('--lang='.length);
      continue;
    }

    if (arg.startsWith('-l') && arg.length > 2) {
      cliLang = arg.slice(2);
      continue;
    }

    if (arg === '-p' || arg === '--provider') {
      cliProvider = takeValue(args, i, arg, 'name');
      i++;
      continue;
    }

    if (arg.startsWith('--provider=')) {
      cliProvider = arg.slice('--provider='.length);
      continue;
    }

    if (arg.startsWith('-p') && arg.length > 2) {
      cliProvider = arg.slice(2);
      continue;
    }

    if (!arg.startsWith('-')) {
      if (targetPath) {
        throw fail(
          ERROR_CATEGORIES.CONFIG,
          `Unexpected extra argument: ${arg}. Use aicommit --help for usage.`,
        );
      }
      targetPath = arg;
    } else {
      throw fail(ERROR_CATEGORIES.CONFIG, `Unknown option: ${arg}. Use aicommit --help for usage.`);
    }
  }

  const reasoningLevels = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (cliReasoning && !reasoningLevels.includes(cliReasoning)) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      `Invalid reasoning level: "${cliReasoning}". Use one of: ${reasoningLevels.join(', ')}`,
    );
  }
  if (!['text', 'json'].includes(output)) {
    throw fail(ERROR_CATEGORIES.CONFIG, `Invalid output mode: "${output}". Use text or json.`);
  }
  if (splitHunks && !['run', 'plan'].includes(splitCommand)) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      '--split-hunks is only valid with "aicommit split run" or "aicommit split plan".',
    );
  }
  if (splitCommand) {
    if (['plan', 'apply'].includes(splitCommand) && !splitPlanFile) {
      throw fail(ERROR_CATEGORIES.CONFIG, `split ${splitCommand} requires --file=<path>.`);
    }
    if (splitCommand === 'run' || splitCommand === 'plan') {
      split ||= 'prompt';
      if (split === 'prompt' && yes) {
        throw fail(
          ERROR_CATEGORIES.CONFIG,
          'Non-interactive split requires an explicit scope: use --scope=staged or --scope=all.',
        );
      }
      if (splitCommand === 'run' && splitPlanFile) {
        throw fail(ERROR_CATEGORIES.CONFIG, 'split run does not accept --file.');
      }
      if (splitCommand === 'plan') dryRun = true;
    } else if (splitCommand === 'apply') {
      if (split || splitHunks) {
        throw fail(
          ERROR_CATEGORIES.CONFIG,
          'split apply reads its scope from the plan; do not pass --scope or --split-hunks.',
        );
      }
      if (cliProvider || cliLang || cliReasoning || dryRun) {
        throw fail(
          ERROR_CATEGORIES.CONFIG,
          'split apply accepts only --file, --yes, --output, and --debug.',
        );
      }
    } else {
      if (
        splitPlanFile ||
        split ||
        splitHunks ||
        cliProvider ||
        cliLang ||
        cliReasoning ||
        dryRun
      ) {
        throw fail(
          ERROR_CATEGORIES.CONFIG,
          `split ${splitCommand} accepts only an optional path, --yes, --output, and --debug.`,
        );
      }
    }
  }
  if (splitScopeOption && !['run', 'plan'].includes(splitCommand)) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      '--scope is only valid with "aicommit split run" or "aicommit split plan".',
    );
  }
  if (splitPlanFile && !['plan', 'apply'].includes(splitCommand)) {
    throw fail(ERROR_CATEGORIES.CONFIG, '--file is only valid with split plan or split apply.');
  }
  if (
    configAction &&
    (cliLang ||
      cliReasoning ||
      split ||
      splitHunks ||
      splitCommand ||
      splitPlanFile ||
      dryRun ||
      yes)
  ) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      'config accepts only an optional path, --provider, --output, and --debug.',
    );
  }
  if (configAction === 'path' && cliProvider) {
    throw fail(ERROR_CATEGORIES.CONFIG, 'config path does not accept --provider.');
  }
  if (
    policyAction &&
    (cliProvider || cliLang || cliReasoning || split || splitHunks || splitCommand || dryRun || yes)
  ) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      'policy check accepts only an optional path, --file or --range, --output, and --debug.',
    );
  }
  if (!policyAction && policyRange) {
    throw fail(ERROR_CATEGORIES.CONFIG, '--range is only valid with "aicommit policy check".');
  }
  if (policyMessageFile && policyRange) {
    throw fail(ERROR_CATEGORIES.CONFIG, 'policy check accepts either --file or --range, not both.');
  }
  if (
    presetAction &&
    (targetPath ||
      cliProvider ||
      cliLang ||
      cliReasoning ||
      split ||
      splitHunks ||
      splitCommand ||
      dryRun ||
      yes)
  ) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      'preset accepts only --file (validate/install), --output, and --debug.',
    );
  }
  if (presetAction === 'install' && !presetFile) {
    throw fail(ERROR_CATEGORIES.CONFIG, 'preset install requires --file=<manifest>.');
  }
  if (presetFile && !['validate', 'install'].includes(presetAction)) {
    throw fail(ERROR_CATEGORIES.CONFIG, '--file is only valid with preset validate or install.');
  }
  if (
    doctor &&
    (targetPath || cliLang || cliReasoning || split || splitPlanFile || dryRun || yes)
  ) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      'doctor accepts only --provider, --output, and --debug options.',
    );
  }

  return {
    targetPath,
    cliLang,
    cliProvider,
    cliReasoning,
    output,
    debug,
    split,
    splitHunks,
    splitCommand,
    splitPlanFile,
    dryRun,
    yes,
    setup,
    doctor,
    configAction,
    policyAction,
    policyMessageFile,
    policyRange,
    presetAction,
    presetFile,
    completionShell: null,
    statsAction: null,
    help: false,
    version: false,
  };
}
