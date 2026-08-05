import { createRequire } from 'node:module';

import chalk from 'chalk';

const _require = createRequire(import.meta.url);
const { version: VERSION } = _require('../package.json');

function showHelp() {
  console.log(`
  ${chalk.cyan.bold('aicommit')} — AI-powered git commit message generator

  ${chalk.bold('Usage:')}
    ${chalk.dim('$')} aicommit [path] [options]

  ${chalk.bold('Arguments:')}
    path                  Target directory (default: current directory)

  ${chalk.bold('Options:')}
    -h, --help            Show this help message
    -v, --version         Show version number
    -l, --lang=<zh|en>    Commit message language (default: zh)
    -m, --model=<name>    Use the named provider from config "providers"
    -s, --split           Split changes into multiple logical commits
    --debug               Print debug info (parsed args, final config, etc.)

  ${chalk.bold('Examples:')}
    aicommit              Commit changes in current directory (Chinese)
    aicommit --lang=en    Generate English commit message
    aicommit -m deepseek  Switch to the "deepseek" provider from config
    aicommit --split      Group changes into several logical commits
    aicommit /path/to    Commit changes in the specified directory
`);
}

function showVersion() {
  console.log(`aicommit v${VERSION}`);
}

export function parseArgs() {
  const args = process.argv.slice(2);
  let targetPath = null;
  let cliLang = null;
  let cliModel = null;
  let debug = false;
  let split = false;

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

    if (arg === '-l' || arg === '--lang') {
      cliLang = args[++i];
      if (!cliLang) {
        console.error(chalk.red(`  Missing value for ${arg}. Use ${arg}=<zh|en>`));
        console.error(chalk.dim('  Use ') + chalk.bold('aicommit --help') + chalk.dim(' for usage.'));
        process.exit(1);
      }
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

    if (arg === '-m' || arg === '--model') {
      cliModel = args[++i];
      if (!cliModel) {
        console.error(chalk.red(`  Missing value for ${arg}. Use ${arg}=<name>`));
        console.error(chalk.dim('  Use ') + chalk.bold('aicommit --help') + chalk.dim(' for usage.'));
        process.exit(1);
      }
      continue;
    }

    if (arg.startsWith('--model=')) {
      cliModel = arg.slice('--model='.length);
      continue;
    }

    if (arg.startsWith('-m') && arg.length > 2) {
      cliModel = arg.slice(2);
      continue;
    }

    if (!arg.startsWith('-')) {
      targetPath = arg;
    } else {
      console.error(chalk.red(`  Unknown option: ${arg}`));
      console.error(chalk.dim('  Use ') + chalk.bold('aicommit --help') + chalk.dim(' for usage.'));
      process.exit(1);
    }
  }

  return { targetPath, cliLang, cliModel, debug, split };
}
