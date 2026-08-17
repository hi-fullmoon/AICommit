import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import chalk from 'chalk';
import ora from 'ora';

import { parseArgs } from './cli.js';
import { loadConfig } from './config.js';
import {
  getStagedDiff, getChangedFiles, getDiffStats, getBranch, gitCommit,
  stripLockFileContent, condenseDiff, getDiffStat, getUntrackedFiles,
  getUnstagedFiles, runGit, isGitRepo,
} from './git.js';
import { generateCommitMessage, checkConnection } from './api.js';
import { statusColor, statusIcon, confirmAction, editMessage, vimSelect, vimCheckbox } from './ui.js';
import { formatMs, maskApiKey, formatUsage, indentError } from './utils.js';
import { splitFlow } from './split.js';
import { runSetup } from './setup.js';

export async function main() {
  // ── CLI arguments ───────────────────────────────────────────────────

  const { targetPath, cliLang, cliProvider, debug, split, check, setup } = parseArgs();

  // The setup wizard is a standalone flow — no git repo, diff, or loaded
  // config required.
  if (setup) {
    await runSetup();
    return;
  }

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

  const { config, projectRoot, loaded, providerName } = await loadConfig(cliProvider);

  if (loaded.length === 0) {
    console.log(chalk.dim('\n  No config files found — using defaults.'));
    console.log(chalk.dim('  Run ') + chalk.bold('aicommit setup') + chalk.dim(' to configure interactively.'));
  } else {
    const labels = loaded.map(l => chalk.bold(l)).join(', ');
    console.log('\n  ' + chalk.green('✓') + chalk.dim(` Config loaded from: ${labels}`));
  }

  // ── CLI language override ─────────────────────────────────────────
  // Apply the -l/--lang override before the summary lines below, so the
  // printed language always reflects the one that will actually be used.
  // Validate after applying the override, so a bad value is caught whether
  // it came from the CLI or from a config file.

  if (cliLang) config.language = cliLang;
  if (config.language !== 'zh' && config.language !== 'en') {
    console.log('\n  ' + chalk.red(`✗ Invalid language: "${config.language}". Use "zh" or "en".\n`));
    process.exit(1);
  }

  if (providerName) {
    const viaCli = cliProvider ? chalk.dim(' (via CLI)') : '';
    console.log('  ' + chalk.green('✓') + chalk.dim(` Model: ${providerName} (${config.modelId})${viaCli}`));
  }

  const langLabel = config.language === 'zh' ? '中文' : 'English';
  const langViaCli = cliLang ? chalk.dim(' (via CLI)') : '';
  console.log('  ' + chalk.green('✓') + chalk.dim(` Language: ${langLabel}${langViaCli}`));

  // ── 1.5. Connection check ───────────────────────────────────────────

  if (check) {
    console.log('');
    const spinner = ora({
      text:  chalk.dim(`Checking ${chalk.bold(config.modelId)} ...`),
      color: 'cyan',
    }).start();

    try {
      const report = await checkConnection(config);
      spinner.succeed('Connection OK');

      console.log('');
      console.log('  ' + chalk.dim('Provider:  ') + (providerName || chalk.dim('(flat config)')));
      console.log('  ' + chalk.dim('Endpoint:  ') + config.apiUrl);
      console.log('  ' + chalk.dim('API key:   ') + maskApiKey(config.apiKey));
      console.log('  ' + chalk.dim('Model:     ') + config.modelId);
      if (report.content) {
        console.log('  ' + chalk.dim('Reply:     ') + `"${report.content.slice(0, 80)}"`);
      } else {
        console.log('  ' + chalk.yellow('Reply:     (empty — endpoint is reachable but the model returned no text)'));
      }
      console.log('  ' + chalk.dim('Latency:   ') + formatMs(report.elapsed));
      if (report.model) console.log('  ' + chalk.dim('Echoed:    ') + report.model);
      if (report.usage) {
        console.log('  ' + chalk.dim('Tokens:    ') + formatUsage(report.usage));
      }
      console.log('');
      process.exit(0);
    } catch (err) {
      spinner.fail('Connection failed');
      console.log(`\n  ${indentError(err)}\n`);
      process.exit(1);
    }
  }

  // An empty apiKey is valid for local, keyless endpoints (Ollama, LM Studio,
  // LiteLLM); the request layer omits the Authorization header for them, so a
  // missing key must not abort the run here.

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
    console.log(chalk.dim(`  cliProvider:  ${cliProvider || '(not set)'}`));
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

  // All git helpers swallow errors and return empty output, so without this
  // guard a non-repo directory would be misreported as "no changes to
  // commit". Placed here (not earlier) so -c/--check and --debug still work
  // outside a repo.
  if (!isGitRepo(projectRoot)) {
    console.log('\n  ' + chalk.red(`✗ Not a git repository: ${process.cwd()}`));
    console.log(chalk.dim('  Run aicommit inside a git working tree.\n'));
    process.exit(1);
  }

  if (split) {
    const handled = await splitFlow(config, projectRoot);
    if (handled) return;
    // Only one changed file — continue with the normal single-commit flow.
  }

  // Only staged changes are considered — the diff the model sees covers
  // exactly what `git commit` will commit. When nothing is staged but the
  // working tree has changes, the user is offered to stage all/some files
  // interactively instead of being sent away to run `git add` manually.
  // All git commands run at the repo root (projectRoot), even when aicommit
  // is invoked from a subdirectory.
  let diff = getStagedDiff(projectRoot, config.diffContextLines);
  if (!diff) {
    // Nothing staged. But git diff --staged is also empty for unstaged work
    // and untracked files — surface what git status actually shows instead of
    // falsely claiming there's nothing to commit.
    const unstaged  = getUnstagedFiles(projectRoot);
    const untracked = getUntrackedFiles(projectRoot);

    const tips = [];
    if (unstaged.length)  tips.push(`${unstaged.length} unstaged file(s)`);
    if (untracked.length) tips.push(`${untracked.length} untracked file(s)`);

    if (!tips.length) {
      console.log('\n  ' + chalk.yellow('✗ No changes to commit.\n'));
      process.exit(1);
    }

    console.log('\n  ' + chalk.yellow(`✗ No staged changes — ${tips.join(', ')}.`) + '\n');
    for (const { status, path } of unstaged) {
      const c = statusColor[status.charAt(0)] || chalk.dim;
      const icon = statusIcon[status.charAt(0)] || status.charAt(0);
      console.log(`  ${c('  ' + icon)} ${c(path)}`);
    }
    for (const path of untracked) {
      const c = statusColor['?'];
      const icon = statusIcon['?'];
      console.log(`  ${c('  ' + icon)} ${c(path)}`);
    }
    console.log('');

    // Offer to stage instead of exiting — the user can stage everything or
    // pick files one by one.
    const stageAction = await vimSelect({
      message: 'No staged changes. How would you like to stage files?',
      choices: [
        { name: 'Stage all changes',      value: 'all',    description: 'Run git add -A (unstaged + untracked)' },
        { name: 'Select files to stage',  value: 'pick',   description: 'Choose files individually' },
        { name: 'Cancel',                 value: 'cancel', description: 'Exit without staging' },
      ],
    });

    if (stageAction === 'cancel') {
      console.log(chalk.dim('\n  Cancelled — stage files with ') + chalk.bold('git add') + chalk.dim(' and run aicommit again.\n'));
      process.exit(0);
    }

    let toStage = null; // null → stage everything
    if (stageAction === 'pick') {
      const choices = [
        ...unstaged.map(({ status, path, addPaths }) => ({
          name: `${statusIcon[status.charAt(0)] || status.charAt(0)} ${path}`,
          value: addPaths,
        })),
        ...untracked.map((path) => ({
          name: `${statusIcon['?']} ${path}`,
          value: [path],
        })),
      ];
      const picked = await vimCheckbox({
        message: 'Select files to stage (space to select, enter to confirm)',
        choices,
      });
      if (!picked.length) {
        console.log(chalk.dim('\n  No files selected — nothing staged.\n'));
        process.exit(0);
      }
      toStage = picked.flat();
    }

    try {
      runGit(toStage ? ['add', '--', ...toStage] : ['add', '-A'], projectRoot);
    } catch (err) {
      console.log('\n  ' + chalk.red(`✗ Failed to stage files: ${err.message}\n`));
      process.exit(1);
    }

    diff = getStagedDiff(projectRoot, config.diffContextLines);
    if (!diff) {
      console.log('\n  ' + chalk.yellow('✗ Nothing staged — no diff to commit.\n'));
      process.exit(1);
    }
  }

  const stats     = getDiffStats(diff);
  const changedFiles = getChangedFiles(projectRoot);
  const branch    = getBranch(projectRoot);
  const stageIcon = chalk.green('staged');
  const changeStr = chalk.green(`+${stats.additions}`) + '  ' + chalk.red(`-${stats.deletions}`);

  let statLine = chalk.dim('  ') + `✓ ${chalk.bold(stats.files)} files (${stageIcon})  ${changeStr}`;
  if (branch) statLine += chalk.dim(`  on ${branch}`);
  console.log(statLine);

  for (const { status, path } of changedFiles) {
    const c = statusColor[status.charAt(0)] || chalk.dim;
    const icon = statusIcon[status.charAt(0)] || status.charAt(0);
    console.log(`  ${c('  ' + icon)} ${c(path)}`);
  }

  // Prepare the diff the model sees (computed once — it doesn't change across
  // regenerations): lock-file and stripFiles contents are stubbed (they carry
  // no commit intent) and oversized diffs are condensed to a --stat summary
  // plus truncated hunks, so token spend stays proportional to what the
  // model needs.
  const strippedDiff = stripLockFileContent(diff, config.stripFiles);
  const { diff: modelDiff, truncated } = condenseDiff(
    strippedDiff, config.maxDiffChars, getDiffStat(projectRoot), config.maxFileDiffChars,
  );
  if (truncated) {
    console.log(chalk.dim(`  (diff condensed for the model — ${strippedDiff.length} → ${modelDiff.length} chars)`));
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
      ({ message, elapsed, usage } = await generateCommitMessage(config, modelDiff, regenerateCount));
      let done = `Generated in ${chalk.bold(formatMs(elapsed))}`;
      if (usage) done += chalk.dim(`  · tokens: ${formatUsage(usage)}`);
      spinner.succeed(done);
    } catch (err) {
      spinner.fail(chalk.red('API call failed'));
      console.log(`\n  ${indentError(err)}\n`);
      // A transient API failure shouldn't kill the session — let the user
      // retry, fall back to the previous message (if any), or cancel.
      const choice = await vimSelect({
        message: 'The API call failed. What would you like to do?',
        choices: [
          ...(message ? [{ name: 'Keep the previous message', value: 'keep' }] : []),
          { name: 'Try again', value: 'retry' },
          { name: 'Cancel', value: 'cancel' },
        ],
      });
      if (choice === 'keep') break; // commit with the previous good message
      if (choice === 'retry') continue;
      console.log(chalk.dim('\n  Commit cancelled.\n'));
      process.exit(0);
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

  // ── 5. Commit ────────────────────────────────────────────────────────

  console.log('');

  const success = gitCommit(message, projectRoot);

  if (success) {
    console.log('\n  ' + chalk.green.bold('✓ Done!\n'));
  } else {
    console.log(chalk.dim('\n  You can manually commit with:'));
    console.log('  ' + chalk.dim('$ ') + chalk.green(`git commit -m '${message.replace(/'/g, "'\\''")}'`));
    console.log('');
  }
}
