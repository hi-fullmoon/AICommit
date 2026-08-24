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
    ${chalk.dim('$')} aicommit split <plan|apply> --file=<path> [options]

  ${chalk.bold('Commands:')}
    setup                 Interactive configuration wizard
    doctor                Diagnose runtime, config, credentials, and connectivity
    split plan            Generate and export a fingerprinted JSON plan
    split apply           Validate and apply an exported JSON plan
    split --resume        Resume the repository's unfinished transaction
    stats [action]        Show quality/cost trends; show, clear, enable, disable
    metrics [action]      Manage local metrics: status, clear, enable, disable

  ${chalk.bold('Arguments:')}
    path                  Target directory (default: current directory)

  ${chalk.bold('Options:')}
    -h, --help            Show this help message
    -v, --version         Show version number
    -l, --lang=<zh|en>    Commit message language (default: zh)
    -p, --provider=<name> Use the named provider from config "providers"
    -s, --split           Choose a split scope interactively
    --split=<scope>       Split staged changes or all changes: staged, all
    --split-hunks         Experimental same-file hunk planning (default: off)
    --scope=<scope>       Scope for "split plan": staged, all
    --file=<path>         Plan artifact path for "split plan/apply"
    --reasoning=<level>   Set reasoning effort (enabled by default: medium)
    --no-reasoning        Explicitly disable reasoning when supported
    --dry-run             Generate and review without creating commits
    -y, --yes             Non-interactive: accept the generated message/plan
    --output=<text|json>  Output mode; JSON requires --yes for commit flows
    -c, --check           Verify the configured LLM is reachable (ping test)
    --debug               Print debug info (parsed args, final config, etc.)

  ${chalk.bold('Examples:')}
    aicommit setup        Run the interactive configuration wizard
    aicommit doctor       Check runtime, config, credentials, and connectivity
    aicommit metrics status  Show local-only metrics status and record count
    aicommit stats        Show local acceptance, quality, latency, and token trends
    aicommit              Commit changes in current directory (Chinese)
    aicommit --lang=en    Generate English commit message
    aicommit -p deepseek  Switch to the "deepseek" provider from config
    aicommit --split      Choose staged/all scope, then plan logical commits
    aicommit --split=staged  Split only the reviewed index snapshot
    aicommit --split=all --yes  Split the complete working tree non-interactively
    aicommit --split=staged --split-hunks  Experimentally split eligible text hunks
    aicommit split plan --scope=staged --file=.aicommit-plan.json --yes
    aicommit split apply --file=.aicommit-plan.json --yes
    aicommit split --resume --yes  Resume pending groups from the checkpoint
    aicommit --reasoning=low  Stream reasoning; Ctrl+O expands/collapses it
    aicommit --dry-run    Review a generated message without committing
    aicommit --yes        Commit already staged changes without prompts
    aicommit --yes --output=json  Emit one machine-readable result on stdout
    aicommit -c           Verify the configured (default) provider is reachable
    aicommit -c -p openrouter  Verify the "openrouter" provider is reachable
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
    check: false,
    setup: false,
    doctor: false,
    statsAction: null,
    metricsAction: null,
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

  if (args[0] === 'metrics') {
    const action = args[1] || 'status';
    if (args.length > 2 || !['status', 'clear', 'enable', 'disable'].includes(action)) {
      throw fail(
        ERROR_CATEGORIES.CONFIG,
        'metrics accepts one action: status, clear, enable, or disable.',
      );
    }
    return parsedDefaults({ metricsAction: action });
  }

  if (args[0] === 'stats') {
    const action = args[1] || 'show';
    if (args.length > 2 || !['show', 'clear', 'enable', 'disable'].includes(action)) {
      throw fail(
        ERROR_CATEGORIES.CONFIG,
        'stats accepts one action: show, clear, enable, or disable.',
      );
    }
    return parsedDefaults({ statsAction: action });
  }

  let splitCommand = null;
  if (args[0] === 'split') {
    splitCommand = args[1] === '--resume' ? 'resume' : args[1];
    if (!['plan', 'apply', 'resume'].includes(splitCommand)) {
      throw fail(ERROR_CATEGORIES.CONFIG, 'split requires plan, apply, or --resume.');
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
  let splitScopeOption = false;
  let dryRun = false;
  let yes = false;
  let check = false;
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

    if (arg === '-s' || arg === '--split') {
      split = 'prompt';
      continue;
    }

    if (arg.startsWith('--split=')) {
      split = arg.slice('--split='.length);
      if (!['staged', 'all'].includes(split)) {
        throw fail(ERROR_CATEGORIES.CONFIG, `Invalid split scope: "${split}". Use staged or all.`);
      }
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
      splitPlanFile = takeValue(args, i, arg, 'path');
      i++;
      continue;
    }

    if (arg.startsWith('--file=')) {
      splitPlanFile = arg.slice('--file='.length);
      if (!splitPlanFile) throw fail(ERROR_CATEGORIES.CONFIG, 'Missing value for --file.');
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

    if (arg === '-c' || arg === '--check') {
      check = true;
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
  if (split === 'prompt' && yes) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      'Non-interactive split requires an explicit scope: use --split=staged or --split=all.',
    );
  }
  if (splitHunks && !split && splitCommand !== 'plan') {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      '--split-hunks requires --split, --split=<scope>, or "aicommit split plan".',
    );
  }
  if (splitCommand) {
    if (splitCommand !== 'resume' && !splitPlanFile) {
      throw fail(ERROR_CATEGORIES.CONFIG, `split ${splitCommand} requires --file=<path>.`);
    }
    if (targetPath) {
      throw fail(ERROR_CATEGORIES.CONFIG, `split ${splitCommand} does not accept a target path.`);
    }
    if (splitCommand === 'plan') {
      split ||= 'prompt';
      dryRun = true;
    } else if (splitCommand === 'apply') {
      if (split || splitHunks) {
        throw fail(
          ERROR_CATEGORIES.CONFIG,
          'split apply reads its scope from the plan; do not pass --scope or --split.',
        );
      }
      if (cliProvider || cliLang || cliReasoning || check || dryRun) {
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
        check ||
        dryRun
      ) {
        throw fail(
          ERROR_CATEGORIES.CONFIG,
          'split --resume accepts only --yes, --output, and --debug.',
        );
      }
    }
  }
  if (splitScopeOption && splitCommand !== 'plan') {
    throw fail(ERROR_CATEGORIES.CONFIG, '--scope is only valid with "aicommit split plan".');
  }
  if (doctor && (targetPath || cliLang || cliReasoning || split || dryRun || yes || check)) {
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
    check,
    setup,
    doctor,
    statsAction: null,
    metricsAction: null,
    help: false,
    version: false,
  };
}
