import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import chalk from 'chalk';
import ora from 'ora';

import { parseArgs } from './cli.js';
import { loadConfig } from './config.js';
import {
  getStagedDiff, getChangedFiles, getDiffStats, getBranch, gitAdd, gitCommit,
} from './git.js';
import { generateCommitMessage } from './api.js';
import { statusColor, statusIcon, confirmAction, editMessage } from './ui.js';
import { formatMs, maskApiKey } from './utils.js';
import { splitFlow } from './split.js';

export async function main() {
  // ── CLI arguments ───────────────────────────────────────────────────

  const { targetPath, cliLang, cliModel, debug, split } = parseArgs();

  if (targetPath) {
    const resolved = resolve(targetPath);
    try {
      await stat(resolved);
      process.chdir(resolved);
    } catch {
      console.error(chalk.red(`  ✗ Error: '${targetPath}' is not a valid directory`));
      process.exit(1);
    }
  }

  // ── Banner ──────────────────────────────────────────────────────────

  console.log('');
  console.log('  ' + chalk.cyan.bold('⚡ aicommit ') + chalk.dim('AI-powered commit message generator'));
  console.log('  ' + chalk.dim('─'.repeat(45)));
  console.log('  ' + chalk.dim(`Working directory: ${process.cwd()}`));

  // ── 1. Config ───────────────────────────────────────────────────────

  const { config, projectRoot, loaded, providerName } = await loadConfig(cliModel);

  if (loaded.length === 0) {
    console.log(chalk.dim('\n  No config files found — using defaults.'));
    console.log(chalk.dim('  Create ~/.aicommit.config.json to configure.'));
  } else {
    const labels = loaded.map(l => chalk.bold(l)).join(', ');
    console.log('\n  ' + chalk.green('✓') + chalk.dim(` Config loaded from: ${labels}`));
  }

  if (providerName) {
    const viaCli = cliModel ? chalk.dim(' (via CLI)') : '';
    console.log('  ' + chalk.green('✓') + chalk.dim(` Model: ${providerName} (${config.modelId})${viaCli}`));
  }

  if (!config.apiKey) {
    console.log('\n  ' + chalk.red('✗ No API key configured.'));
    console.log(chalk.dim('  Set "apiKey" in ~/.aicommit.config.json or ./.aicommit.config.json\n'));
    process.exit(1);
  }

  // ── CLI language override ────────────────────────────────────────────

  if (cliLang) {
    if (cliLang !== 'zh' && cliLang !== 'en') {
      console.log('\n  ' + chalk.red(`✗ Invalid language: "${cliLang}". Use "zh" or "en".\n`));
      process.exit(1);
    }
    config.language = cliLang;
    console.log('  ' + chalk.green('✓') + chalk.dim(` Language set to: ${cliLang === 'zh' ? '中文' : 'English'} (via CLI)`));
  }

  // ── Debug output ─────────────────────────────────────────────────────

  if (debug) {
    console.log('');
    console.log('  ' + chalk.magenta.bold('🐛 Debug info'));
    console.log('  ' + chalk.dim('─'.repeat(45)));
    console.log(chalk.dim(`  argv:         ${process.argv.slice(2).join(' ') || '(none)'}`));
    console.log(chalk.dim(`  targetPath:   ${targetPath || '(not set)'}`));
    console.log(chalk.dim(`  cwd:          ${process.cwd()}`));
    console.log(chalk.dim(`  projectRoot:  ${projectRoot}`));
    console.log(chalk.dim(`  config files: ${loaded.join(', ') || '(none — defaults only)'}`));
    console.log(chalk.dim(`  cliLang:      ${cliLang || '(not set)'}`));
    console.log(chalk.dim(`  cliModel:     ${cliModel || '(not set)'}`));
    console.log(chalk.dim(`  providerName: ${providerName || '(not set)'}`));
    console.log(chalk.dim(`  split:        ${split}`));
    console.log(chalk.dim('  final config:'));
    for (const [key, value] of Object.entries(config)) {
      const display = key === 'apiKey'
        ? maskApiKey(value)
        : JSON.stringify(value);
      const truncated = display.length > 100 ? display.slice(0, 100) + '…' : display;
      console.log(chalk.dim(`    ${key}: ${truncated}`));
    }
  }

  // ── 2. Diff ─────────────────────────────────────────────────────────

  if (split) {
    const handled = await splitFlow(config, projectRoot);
    if (handled) return;
    // Only one changed file — continue with the normal single-commit flow.
  }

  const { diff, isStaged } = getStagedDiff();
  if (!diff) {
    console.log('\n  ' + chalk.yellow('✗ No changes to commit.'));
    console.log(chalk.dim('  Stage your changes with ') + chalk.bold('git add') + chalk.dim(' first.\n'));
    process.exit(1);
  }

  const stats     = getDiffStats(diff);
  const changedFiles = getChangedFiles(isStaged);
  const branch    = getBranch();
  const stageIcon = isStaged ? chalk.green('staged') : chalk.yellow('unstaged');
  const changeStr = chalk.green(`+${stats.additions}`) + '  ' + chalk.red(`-${stats.deletions}`);

  let statLine = chalk.dim('  ') + `✓ ${chalk.bold(stats.files)} files (${stageIcon})  ${changeStr}`;
  if (branch) statLine += chalk.dim(`  on ${branch}`);
  console.log(statLine);

  for (const { status, path } of changedFiles) {
    const c = statusColor[status.charAt(0)] || chalk.dim;
    const icon = statusIcon[status.charAt(0)] || status.charAt(0);
    console.log(`  ${c('  ' + icon)} ${c(path)}`);
  }

  // ── 3. AI call + confirm (with regenerate loop) ────────────────────

  let message, elapsed, usage;
  let regenerateCount = 0;

  while (true) {
    const spinner = ora({
      text:  chalk.dim(`Calling ${chalk.bold(config.modelId)} ...`),
      color: 'cyan',
    }).start();

    try {
      ({ message, elapsed, usage } = await generateCommitMessage(config, diff, regenerateCount));
      let done = `Generated in ${chalk.bold(formatMs(elapsed))}`;
      if (usage) {
        const tk = `${chalk.dim('tokens:')} ${usage.prompt_tokens}+${usage.completion_tokens}`;
        done += chalk.dim(`  (${tk})`);
      }
      spinner.succeed(done);
    } catch (err) {
      spinner.fail(chalk.red('API call failed'));
      console.log(`\n  ${err.message.split('\n').join('\n  ')}\n`);
      process.exit(1);
    }

    if (!message) {
      console.log('\n  ' + chalk.red('✗ Empty response from AI.\n'));
      process.exit(1);
    }

    // ── 4. User action ─────────────────────────────────────────────────

    const action = await confirmAction(message);

    if (action === 'use') {
      break; // proceed to commit
    }

    if (action === 'edit') {
      const edited = await editMessage(message);
      if (edited) {
        message = edited;
        break; // proceed to commit with edited message
      }
      // User cancelled during edit — exit
      console.log(chalk.dim('\n  Commit cancelled.\n'));
      process.exit(0);
    }

    if (action === 'regenerate') {
      regenerateCount++;
      console.log(chalk.dim(`\n  ↻ Regenerating (attempt #${regenerateCount + 1})...`));
      continue;
    }

    // action === 'cancel'
    console.log(chalk.dim('\n  Commit cancelled.\n'));
    process.exit(0);
  }

  // ── 5. Auto-stage (if unstaged) & commit ────────────────────────────

  console.log('');

  if (!isStaged) {
    process.stdout.write(chalk.dim('  → Auto-staging changes... '));
    try {
      gitAdd(projectRoot);
      console.log(chalk.green('✓'));
    } catch {
      console.log(chalk.yellow('⚠'));
    }
  }

  const success = gitCommit(message, projectRoot);

  if (success) {
    console.log('\n  ' + chalk.green.bold('✓ Done!\n'));
  } else {
    console.log(chalk.dim('\n  You can manually commit with:'));
    console.log('  ' + chalk.dim('$ ') + chalk.green(`git commit -m '${message.replace(/'/g, "'\\''")}'`));
    console.log('');
  }
}
