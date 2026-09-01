import { createRequire } from 'node:module';

import chalk from 'chalk';

import { ERROR_CATEGORIES, fail } from './errors.js';
import { REASONING_EFFORTS } from './providers.js';

const _require = createRequire(import.meta.url);
const { version: VERSION } = _require('../package.json');

function showHelp() {
  console.log(`
  ${chalk.cyan.bold('aicommit')} — AI-powered git commit message generator

  ${chalk.bold('Usage:')}
    ${chalk.dim('$')} aicommit [path] [options]
    ${chalk.dim('$')} aicommit setup
    ${chalk.dim('$')} aicommit update
    ${chalk.dim('$')} aicommit split [run|plan|apply|resume|abort] [options]

  ${chalk.bold('Everyday commands:')}
    setup                 Interactive configuration wizard
    update                Update the global npm installation to latest
    doctor                Diagnose runtime, config, credentials, and connectivity
    split                 Plan and create file-level logical commits

  ${chalk.bold('Advanced commands:')}
    config show           Print the effective configuration with secrets redacted
    config validate       Parse, merge, and validate configuration without reading credentials
    config path           Print user, project, and team-policy paths
    policy template       Print a safe repository team-policy template
    policy check          Validate a message file or Git range with the effective team policy
    completion            Generate Bash, Zsh, or Fish completion on stdout
    split plan            Generate and export a fingerprinted JSON plan
    split apply           Validate and apply an exported JSON plan
    split resume          Resume the repository's unfinished transaction
    split abort           Discard recovery metadata; keep commits and changes

  ${chalk.bold('Arguments:')}
    path                  Target directory (default: current directory)

  ${chalk.bold('Options:')}
    -h, --help            Show this help message
    -v, --version         Show version number
    -l, --lang=<zh|en>    Commit message language (default: zh)
    -p, --provider=<name> Use the named provider from config "providers"
    -m, --model=<name>    Use a named model from the selected provider
    --scope=<scope>       Scope for "split|split plan": staged, all
    --file=<path>         Split-plan artifact or commit-message file
    --range=<revision>    Git revision/range for "policy check" (default: HEAD)
    --reasoning=<level>   Set reasoning effort (enabled by default: medium)
    --no-reasoning        Explicitly disable reasoning when supported
    --dry-run             Generate and review without creating commits
    -y, --yes             Non-interactive: accept the generated message/plan
    --output=<text|json>  Output mode; JSON requires --yes for commit flows
    --debug               Print debug info (parsed args, final config, etc.)

  ${chalk.bold('Examples:')}
    aicommit              Commit changes in current directory (Chinese)
    aicommit --lang=en    Generate English commit message
    aicommit split --scope=staged  Split only the reviewed index snapshot
    aicommit --dry-run    Review a generated message without committing
    aicommit --yes        Commit already staged changes without prompts
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
    cliModel: null,
    cliReasoning: null,
    output: 'text',
    debug: false,
    split: null,
    splitCommand: null,
    splitPlanFile: null,
    dryRun: false,
    yes: false,
    setup: false,
    update: false,
    doctor: false,
    configAction: null,
    policyAction: null,
    policyMessageFile: null,
    policyRange: null,
    completionShell: null,
    help: false,
    version: false,
    ...overrides,
  };
}

export function parseArgs(args = process.argv.slice(2)) {
  if (args[0] === 'stats' || args[0] === 'preset') {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      `The "${args[0]}" command was removed to keep aicommit focused on commit generation.`,
    );
  }

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

  if (args[0] === 'completion') {
    const shell = args[1];
    if (args.length !== 2 || !['bash', 'zsh', 'fish'].includes(shell)) {
      throw fail(ERROR_CATEGORIES.CONFIG, 'completion requires one shell: bash, zsh, or fish.');
    }
    return parsedDefaults({ completionShell: shell });
  }

  const update = args[0] === 'update';
  if (update) args = args.slice(1);

  if (!update && args[0] === 'policy' && args[1] === 'template') {
    if (args.length !== 2) {
      throw fail(ERROR_CATEGORIES.CONFIG, 'policy template takes no arguments.');
    }
    return parsedDefaults({ policyAction: 'template' });
  }

  let policyAction = null;
  if (!update && args[0] === 'policy') {
    policyAction = args[1];
    if (policyAction !== 'check') {
      throw fail(ERROR_CATEGORIES.CONFIG, 'policy requires one action: template or check.');
    }
    args = args.slice(2);
  }

  let configAction = null;
  if (!update && args[0] === 'config') {
    configAction = args[1];
    if (!['show', 'validate', 'path'].includes(configAction)) {
      throw fail(ERROR_CATEGORIES.CONFIG, 'config requires one action: show, validate, or path.');
    }
    args = args.slice(2);
  }

  let splitCommand = null;
  if (!update && args[0] === 'split') {
    const requestedAction = args[1];
    const actions = ['run', 'plan', 'apply', 'resume', 'abort'];
    if (!requestedAction || requestedAction.startsWith('-')) {
      // Keep the common path short: `aicommit split` is the interactive
      // split flow, while explicit actions remain available for automation
      // and recovery.
      splitCommand = 'run';
      args = args.slice(1);
    } else if (actions.includes(requestedAction)) {
      splitCommand = requestedAction;
      args = args.slice(2);
    } else {
      throw fail(
        ERROR_CATEGORIES.CONFIG,
        'split requires one action: run, plan, apply, resume, or abort.',
      );
    }
  }

  const doctor = !update && args[0] === 'doctor';
  if (doctor) args = args.slice(1);

  let targetPath = null;
  let cliLang = null;
  let cliProvider = null;
  let cliModel = null;
  let cliReasoning = null;
  let output = 'text';
  let debug = false;
  let split = null;
  let splitPlanFile = null;
  let policyMessageFile = null;
  let policyRange = null;
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
      else splitPlanFile = value;
      i++;
      continue;
    }

    if (arg.startsWith('--file=')) {
      const value = arg.slice('--file='.length);
      if (!value) throw fail(ERROR_CATEGORIES.CONFIG, 'Missing value for --file.');
      if (policyAction) policyMessageFile = value;
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

    if (arg === '-m' || arg === '--model') {
      cliModel = takeValue(args, i, arg, 'name');
      i++;
      continue;
    }

    if (arg.startsWith('--model=')) {
      cliModel = arg.slice('--model='.length);
      if (!cliModel) throw fail(ERROR_CATEGORIES.CONFIG, 'Missing value for --model.');
      continue;
    }

    if (arg.startsWith('-m') && arg.length > 2) {
      cliModel = arg.slice(2);
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

  const reasoningLevels = ['off', ...REASONING_EFFORTS];
  if (cliReasoning && !reasoningLevels.includes(cliReasoning)) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      `Invalid reasoning level: "${cliReasoning}". Use one of: ${reasoningLevels.join(', ')}`,
    );
  }
  if (!['text', 'json'].includes(output)) {
    throw fail(ERROR_CATEGORIES.CONFIG, `Invalid output mode: "${output}". Use text or json.`);
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
      if (split) {
        throw fail(
          ERROR_CATEGORIES.CONFIG,
          'split apply reads its scope from the plan; do not pass --scope.',
        );
      }
      if (cliProvider || cliModel || cliLang || cliReasoning || dryRun) {
        throw fail(
          ERROR_CATEGORIES.CONFIG,
          'split apply accepts only --file, --yes, --output, and --debug.',
        );
      }
    } else {
      if (splitPlanFile || split || cliProvider || cliModel || cliLang || cliReasoning || dryRun) {
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
    (cliLang || cliReasoning || split || splitCommand || splitPlanFile || dryRun || yes)
  ) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      'config accepts only an optional path, --provider, --model, --output, and --debug.',
    );
  }
  if (configAction === 'path' && (cliProvider || cliModel)) {
    throw fail(ERROR_CATEGORIES.CONFIG, 'config path does not accept --provider or --model.');
  }
  if (
    policyAction &&
    (cliProvider || cliModel || cliLang || cliReasoning || split || splitCommand || dryRun || yes)
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
    doctor &&
    (targetPath || cliLang || cliReasoning || split || splitPlanFile || dryRun || yes)
  ) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      'doctor accepts only --provider, --model, --output, and --debug options.',
    );
  }
  if (
    update &&
    (targetPath ||
      cliLang ||
      cliProvider ||
      cliModel ||
      cliReasoning ||
      split ||
      splitCommand ||
      splitPlanFile ||
      dryRun ||
      yes ||
      configAction ||
      policyAction ||
      policyMessageFile ||
      policyRange)
  ) {
    throw fail(ERROR_CATEGORIES.CONFIG, 'update accepts only --output and --debug options.');
  }

  return {
    targetPath,
    cliLang,
    cliProvider,
    cliModel,
    cliReasoning,
    output,
    debug,
    split,
    splitCommand,
    splitPlanFile,
    dryRun,
    yes,
    setup,
    update,
    doctor,
    configAction,
    policyAction,
    policyMessageFile,
    policyRange,
    completionShell: null,
    help: false,
    version: false,
  };
}
