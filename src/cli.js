import { createRequire } from 'node:module';

import chalk from 'chalk';

const _require = createRequire(import.meta.url);
const { version: VERSION } = _require('../package.json');

function showHelp() {
  console.log(`
  ${chalk.cyan.bold('aicommit')} — AI-powered git commit message generator

  ${chalk.bold('Usage:')}
    ${chalk.dim('$')} aicommit [path] [options]
    ${chalk.dim('$')} aicommit setup

  ${chalk.bold('Commands:')}
    setup                 Interactive configuration wizard

  ${chalk.bold('Arguments:')}
    path                  Target directory (default: current directory)

  ${chalk.bold('Options:')}
    -h, --help            Show this help message
    -v, --version         Show version number
    -l, --lang=<zh|en>    Commit message language (default: zh)
    -p, --provider=<name> Use the named provider from config "providers"
    -s, --split           Split changes into multiple logical commits
    --reasoning=<level>   Set reasoning effort (enabled by default: low)
    --no-reasoning        Explicitly disable reasoning when supported
    --dry-run             Generate and review without creating commits
    -c, --check           Verify the configured LLM is reachable (ping test)
    --debug               Print debug info (parsed args, final config, etc.)

  ${chalk.bold('Examples:')}
    aicommit setup        Run the interactive configuration wizard
    aicommit              Commit changes in current directory (Chinese)
    aicommit --lang=en    Generate English commit message
    aicommit -p deepseek  Switch to the "deepseek" provider from config
    aicommit --split      Group changes into several logical commits
    aicommit --reasoning=low  Stream reasoning; Ctrl+O expands/collapses it
    aicommit --dry-run    Review a generated message without committing
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
    console.error(chalk.red(`  Missing value for ${arg}. Use ${arg}=<${hint}>`));
    console.error(chalk.dim('  Use ') + chalk.bold('aicommit --help') + chalk.dim(' for usage.'));
    process.exit(1);
  }
  return next;
}

export function parseArgs(args = process.argv.slice(2)) {

  // "setup" is a standalone subcommand — it doesn't combine with the
  // commit-flow options, so short-circuit before parsing them.
  if (args[0] === 'setup') {
    if (args.length > 1) {
      console.error(chalk.red(`  "setup" takes no arguments — got: ${args.slice(1).join(' ')}`));
      process.exit(1);
    }
    return {
      targetPath: null, cliLang: null, cliProvider: null,
      cliReasoning: null,
      debug: false, split: false, dryRun: false, check: false, setup: true,
    };
  }

  let targetPath = null;
  let cliLang = null;
  let cliProvider = null;
  let cliReasoning = null;
  let debug = false;
  let split = false;
  let dryRun = false;
  let check = false;
  const setup = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      showHelp();
      process.exit(0);
    }

    if (arg === '-v' || arg === '--version') {
      showVersion();
      process.exit(0);
    }

    if (arg === '--debug') {
      debug = true;
      continue;
    }

    if (arg === '-s' || arg === '--split') {
      split = true;
      continue;
    }

    if (arg === '--dry-run') {
      dryRun = true;
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
        console.error(chalk.red('  Missing value for --reasoning.'));
        process.exit(1);
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
        console.error(chalk.red(`  Unexpected extra argument: ${arg}`));
        console.error(chalk.dim('  Use ') + chalk.bold('aicommit --help') + chalk.dim(' for usage.'));
        process.exit(1);
      }
      targetPath = arg;
    } else {
      console.error(chalk.red(`  Unknown option: ${arg}`));
      console.error(chalk.dim('  Use ') + chalk.bold('aicommit --help') + chalk.dim(' for usage.'));
      process.exit(1);
    }
  }

  const reasoningLevels = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (cliReasoning && !reasoningLevels.includes(cliReasoning)) {
    console.error(chalk.red(`  Invalid reasoning level: "${cliReasoning}".`));
    console.error(chalk.dim(`  Use one of: ${reasoningLevels.join(', ')}`));
    process.exit(1);
  }

  return {
    targetPath, cliLang, cliProvider, cliReasoning,
    debug, split, dryRun, check, setup,
  };
}
