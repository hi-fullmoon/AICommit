import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import chalk from 'chalk';
import ora from 'ora';

import { parseArgs } from './cli.js';
import { loadConfig } from './config.js';
import {
  getStagedDiff,
  getChangedFiles,
  getDiffStats,
  getBranch,
  gitCommit,
  stripLockFileContent,
  condenseDiff,
  getDiffStat,
  getUntrackedFiles,
  getUnstagedFiles,
  runGit,
  isGitRepo,
  getIndexFingerprint,
  createIndexTransaction,
  protectSensitiveDiff,
} from './git.js';
import { generateCommitMessage, checkConnection } from './api.js';
import {
  statusColor,
  statusIcon,
  confirmAction,
  editMessage,
  vimSelect,
  vimCheckbox,
  startReasoningStream,
} from './ui.js';
import {
  formatMs,
  maskApiKey,
  formatUsage,
  indentError,
  sanitizeTerminalText,
  stringifyConfigRedacted,
} from './utils.js';
import { splitFlow } from './split.js';
import { runSetup } from './setup.js';

export async function main() {
  // ── CLI arguments ───────────────────────────────────────────────────

  const {
    targetPath,
    cliLang,
    cliProvider,
    cliReasoning,
    debug,
    split,
    dryRun,
    yes,
    check,
    setup,
  } = parseArgs();

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
  console.log(
    '  ' + chalk.cyan.bold('⚡ aicommit ') + chalk.dim('AI-powered commit message generator'),
  );
  console.log('  ' + chalk.dim('─'.repeat(45)));
  console.log('  ' + chalk.dim(`Working directory: ${sanitizeTerminalText(process.cwd())}`));

  // ── 1. Config ───────────────────────────────────────────────────────

  const { config, projectRoot, loaded, providerName } = await loadConfig(cliProvider);

  if (loaded.length === 0) {
    console.log(chalk.dim('\n  No config files found — using defaults.'));
    console.log(
      chalk.dim('  Run ') +
        chalk.bold('aicommit setup') +
        chalk.dim(' to configure interactively.'),
    );
  } else {
    const labels = loaded.map((l) => chalk.bold(l)).join(', ');
    console.log('\n  ' + chalk.green('✓') + chalk.dim(` Config loaded from: ${labels}`));
  }

  // ── CLI language override ─────────────────────────────────────────
  // Apply the -l/--lang override before the summary lines below, so the
  // printed language always reflects the one that will actually be used.
  // Validate after applying the override, so a bad value is caught whether
  // it came from the CLI or from a config file.

  if (cliLang) config.language = cliLang;
  if (config.language !== 'zh' && config.language !== 'en') {
    console.log(
      '\n  ' + chalk.red(`✗ Invalid language: "${config.language}". Use "zh" or "en".\n`),
    );
    process.exit(1);
  }

  if (cliReasoning === 'off') {
    config.reasoning = { ...config.reasoning, mode: 'off' };
  } else if (cliReasoning) {
    config.reasoning = { ...config.reasoning, mode: 'on', effort: cliReasoning };
  }
  const reasoningEnabled = config.reasoning.mode === 'on';

  const viaCli = cliProvider ? chalk.dim(' (via CLI)') : '';
  const modelLabel = providerName ? `${providerName} (${config.modelId})` : config.modelId;
  console.log(
    '  ' + chalk.green('✓') + chalk.dim(` Model: ${sanitizeTerminalText(modelLabel)}${viaCli}`),
  );
  console.log(
    '  ' + chalk.green('✓') + chalk.dim(` Endpoint: ${sanitizeTerminalText(config.apiUrl)}`),
  );

  const langLabel = config.language === 'zh' ? '中文' : 'English';
  const langViaCli = cliLang ? chalk.dim(' (via CLI)') : '';
  console.log('  ' + chalk.green('✓') + chalk.dim(` Language: ${langLabel}${langViaCli}`));
  if (config.reasoning.mode === 'on') {
    console.log(
      '  ' +
        chalk.green('✓') +
        chalk.dim(` Reasoning: ${config.reasoning.effort}${cliReasoning ? ' (via CLI)' : ''}`),
    );
  } else if (config.reasoning.mode === 'off' && cliReasoning) {
    console.log('  ' + chalk.green('✓') + chalk.dim(' Reasoning: off (via CLI)'));
  }

  // ── 1.5. Connection check ───────────────────────────────────────────

  if (check) {
    console.log('');
    const spinner = ora({
      text: chalk.dim(`Checking ${chalk.bold(config.modelId)} ...`),
      color: 'cyan',
    }).start();
    let reasoningStream;
    const stream = reasoningEnabled
      ? {
          onReasoningDelta(chunk) {
            if (!reasoningStream) {
              spinner.stop();
              reasoningStream = startReasoningStream(config.reasoning.maxDisplayChars, chunk);
              return;
            }
            reasoningStream.append(chunk);
          },
        }
      : null;

    try {
      const report = await checkConnection(config, stream);
      if (reasoningStream) await reasoningStream.stop();
      spinner.succeed('Connection OK');

      console.log('');
      console.log('  ' + chalk.dim('Provider:  ') + (providerName || chalk.dim('(flat config)')));
      console.log('  ' + chalk.dim('Endpoint:  ') + config.apiUrl);
      console.log('  ' + chalk.dim('API key:   ') + maskApiKey(config.apiKey));
      console.log('  ' + chalk.dim('Model:     ') + config.modelId);
      if (report.content) {
        console.log(
          '  ' +
            chalk.dim('Reply:     ') +
            `"${sanitizeTerminalText(report.content.slice(0, 80))}"`,
        );
      } else {
        console.log(
          '  ' +
            chalk.yellow(
              'Reply:     (empty — endpoint is reachable but the model returned no text)',
            ),
        );
      }
      console.log('  ' + chalk.dim('Latency:   ') + formatMs(report.elapsed));
      if (report.model)
        console.log('  ' + chalk.dim('Echoed:    ') + sanitizeTerminalText(report.model));
      if (report.usage) {
        console.log('  ' + chalk.dim('Tokens:    ') + formatUsage(report.usage));
      }
      console.log('');
      process.exit(0);
    } catch (err) {
      if (reasoningStream) await reasoningStream.stop();
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
    console.log(
      chalk.dim(
        `  reasoning:    ${config.reasoning.mode === 'on' ? config.reasoning.effort : config.reasoning.mode}${cliReasoning ? ' (via CLI)' : ''}`,
      ),
    );
    console.log(chalk.dim(`  providerName: ${providerName || '(not set)'}`));
    console.log(chalk.dim(`  split:        ${split}`));
    console.log(chalk.dim(`  dryRun:       ${dryRun}`));
    console.log(chalk.dim(`  yes:          ${yes}`));
    console.log(chalk.dim('  final config:'));
    for (const [key, value] of Object.entries(config)) {
      const display = key === 'apiKey' ? maskApiKey(value) : stringifyConfigRedacted(value);
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
    const handled = await splitFlow(config, projectRoot, { dryRun, yes });
    if (handled) return;
    // Only one changed file — continue with the normal single-commit flow.
  }

  // Only staged changes are considered — the diff the model sees covers
  // exactly what `git commit` will commit. When nothing is staged but the
  // working tree has changes, the user is offered to stage all/some files
  // interactively instead of being sent away to run `git add` manually.
  // All git commands run at the repo root (projectRoot), even when aicommit
  // is invoked from a subdirectory.
  let indexTransaction = null;
  const beginIndexTransaction = () => {
    indexTransaction ||= createIndexTransaction(projectRoot);
    return indexTransaction;
  };
  let diff = getStagedDiff(projectRoot, config.diffContextLines);
  const hadStaged = Boolean(diff);
  if (!diff) {
    // Nothing staged. But git diff --staged is also empty for unstaged work
    // and untracked files — surface what git status actually shows instead of
    // falsely claiming there's nothing to commit.
    const unstaged = getUnstagedFiles(projectRoot);
    const untracked = getUntrackedFiles(projectRoot);

    const tips = [];
    if (unstaged.length) tips.push(`${unstaged.length} unstaged file(s)`);
    if (untracked.length) tips.push(`${untracked.length} untracked file(s)`);

    if (!tips.length) {
      console.log('\n  ' + chalk.yellow('✗ No changes to commit.\n'));
      process.exit(1);
    }

    console.log('\n  ' + chalk.yellow(`✗ No staged changes — ${tips.join(', ')}.`));
    for (const { status, path } of unstaged) {
      const c = statusColor[status.charAt(0)] || chalk.dim;
      const icon = statusIcon[status.charAt(0)] || status.charAt(0);
      console.log(`  ${c('  ' + icon)} ${c(sanitizeTerminalText(path))}`);
    }
    for (const path of untracked) {
      const c = statusColor['?'];
      const icon = statusIcon['?'];
      console.log(`  ${c('  ' + icon)} ${c(sanitizeTerminalText(path))}`);
    }
    console.log('');

    if (yes && !dryRun) {
      console.log(chalk.red('  ✗ --yes requires changes to be staged explicitly.'));
      console.log(
        chalk.dim('  Stage the intended files with git add, then run aicommit --yes again.\n'),
      );
      process.exit(1);
    }

    // Offer to stage instead of exiting — the user can stage everything or
    // pick files one by one.
    const stageAction = yes
      ? 'all'
      : await vimSelect({
          message: 'No staged changes. How would you like to stage files?',
          choices: [
            {
              name: 'Stage all changes',
              value: 'all',
              description: 'Run git add -A (unstaged + untracked)',
            },
            {
              name: 'Select files to stage',
              value: 'pick',
              description: 'Choose files individually',
            },
            { name: 'Cancel', value: 'cancel', description: 'Exit without staging' },
          ],
        });

    if (stageAction === 'cancel') {
      console.log(
        chalk.dim('\n  Cancelled — stage files with ') +
          chalk.bold('git add') +
          chalk.dim(' and run aicommit again.\n'),
      );
      process.exit(0);
    }

    let toStage = null; // null → stage everything
    if (stageAction === 'pick') {
      const choices = [
        ...unstaged.map(({ status, path, addPaths }) => ({
          name: `${statusIcon[status.charAt(0)] || status.charAt(0)} ${sanitizeTerminalText(path)}`,
          value: addPaths,
        })),
        ...untracked.map((path) => ({
          name: `${statusIcon['?']} ${sanitizeTerminalText(path)}`,
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
      beginIndexTransaction();
      runGit(toStage ? ['add', '--', ...toStage] : ['add', '-A'], projectRoot);
      indexTransaction.markOwned();
    } catch (err) {
      indexTransaction?.restore({ force: true });
      indexTransaction = null;
      console.log(
        '\n  ' + chalk.red(`✗ Failed to stage files: ${sanitizeTerminalText(err.message)}\n`),
      );
      process.exit(1);
    }

    diff = getStagedDiff(projectRoot, config.diffContextLines);
    if (!diff) {
      console.log('\n  ' + chalk.yellow('✗ Nothing staged — no diff to commit.\n'));
      process.exit(1);
    }
  }

  // Staged-only is the design, but when the working tree holds more changes
  // the user may simply have forgotten to stage them — offer to fold them in
  // instead of committing a subset silently. Skipped when staging just
  // happened interactively above (the user already made that choice there).
  if (hadStaged && !yes) {
    const unstaged = getUnstagedFiles(projectRoot);
    const untracked = getUntrackedFiles(projectRoot);

    if (unstaged.length || untracked.length) {
      // List both sides before asking — the choice is only meaningful when
      // the user can see what is already staged and what would be added.
      console.log('\n  ' + chalk.green('✓ Already staged:'));
      for (const { status, path } of getChangedFiles(projectRoot)) {
        const c = statusColor[status.charAt(0)] || chalk.dim;
        const icon = statusIcon[status.charAt(0)] || status.charAt(0);
        console.log(`  ${c('  ' + icon)} ${c(sanitizeTerminalText(path))}`);
      }
      console.log('');
      console.log(
        '  ' +
          chalk.cyan(
            `✗ ${unstaged.length + untracked.length} more file(s) with unstaged/untracked changes:`,
          ),
      );
      for (const { status, path } of unstaged) {
        const c = statusColor[status.charAt(0)] || chalk.dim;
        const icon = statusIcon[status.charAt(0)] || status.charAt(0);
        console.log(`  ${c('  ' + icon)} ${c(sanitizeTerminalText(path))}`);
      }
      for (const path of untracked) {
        const c = statusColor['?'];
        const icon = statusIcon['?'];
        console.log(`  ${c('  ' + icon)} ${c(sanitizeTerminalText(path))}`);
      }
      console.log('');

      const include = await vimSelect({
        message: 'Include them in this commit?',
        choices: [
          {
            name: 'No, commit the staged changes only',
            value: 'no',
            description: 'Leave the rest for a later commit',
          },
          {
            name: 'Yes, stage everything',
            value: 'all',
            description: 'Run git add -A and commit it all together',
          },
          {
            name: 'Pick files to add',
            value: 'pick',
            description: 'Choose additional files to stage',
          },
        ],
      });

      let extra = null; // null → stage everything
      if (include === 'pick') {
        const choices = [
          ...unstaged.map(({ status, path, addPaths }) => ({
            name: `${statusIcon[status.charAt(0)] || status.charAt(0)} ${sanitizeTerminalText(path)}`,
            value: addPaths,
          })),
          ...untracked.map((path) => ({
            name: `${statusIcon['?']} ${sanitizeTerminalText(path)}`,
            value: [path],
          })),
        ];
        const picked = await vimCheckbox({
          message: 'Select additional files to stage (space to select, enter to confirm)',
          choices,
        });
        if (!picked.length) {
          console.log(chalk.dim('  No files selected — committing the staged changes only.'));
        } else {
          extra = picked.flat();
        }
      }

      if (include === 'all' || extra) {
        try {
          beginIndexTransaction();
          runGit(extra ? ['add', '--', ...extra] : ['add', '-A'], projectRoot);
          indexTransaction.markOwned();
          diff = getStagedDiff(projectRoot, config.diffContextLines);
        } catch (err) {
          indexTransaction?.restore({ force: true });
          indexTransaction = null;
          console.log(
            '  ' +
              chalk.red(
                `✗ Failed to stage files: ${sanitizeTerminalText(err.message)} — committing the staged changes only.`,
              ),
          );
        }
      }
    }
  }

  // Re-read the final diff between two complete-index fingerprints so the
  // prompt is guaranteed to describe one stable staged snapshot.
  const plannedIndexFingerprint = getIndexFingerprint(projectRoot);
  diff = getStagedDiff(projectRoot, config.diffContextLines);
  if (getIndexFingerprint(projectRoot) !== plannedIndexFingerprint) {
    console.log(
      '\n  ' + chalk.red('✗ The staged changes are being modified concurrently; commit aborted.\n'),
    );
    process.exitCode = 1;
    return;
  }

  const stats = getDiffStats(diff);
  const changedFiles = getChangedFiles(projectRoot);
  const branch = getBranch(projectRoot);
  const stageIcon = chalk.green('staged');
  const changeStr = chalk.green(`+${stats.additions}`) + '  ' + chalk.red(`-${stats.deletions}`);

  let statLine =
    chalk.dim('  ') + `✓ ${chalk.bold(stats.files)} files (${stageIcon})  ${changeStr}`;
  if (branch) statLine += chalk.dim(`  on ${sanitizeTerminalText(branch)}`);
  console.log(statLine);

  for (const { status, path } of changedFiles) {
    const c = statusColor[status.charAt(0)] || chalk.dim;
    const icon = statusIcon[status.charAt(0)] || status.charAt(0);
    console.log(`  ${c('  ' + icon)} ${c(sanitizeTerminalText(path))}`);
  }

  // Protect common secrets before any repository content leaves the machine.
  // The protected diff affects only the model request, never the actual index.
  const protectedInput = protectSensitiveDiff(diff);
  let diffForModel = diff;
  if (protectedInput.findings.length) {
    console.log('\n  ' + chalk.yellow.bold('⚠ Potential sensitive data detected:'));
    for (const finding of protectedInput.findings) {
      console.log('    ' + chalk.yellow(sanitizeTerminalText(finding)));
    }
    const sensitiveAction = yes
      ? 'protect'
      : await vimSelect({
          message: 'How should aicommit handle the model request?',
          choices: [
            {
              name: 'Send protected diff',
              value: 'protect',
              description:
                'Omit sensitive files/private keys and redact detected credential values',
            },
            { name: 'Cancel', value: 'cancel', description: 'Do not send repository content' },
            {
              name: 'Send original diff',
              value: 'original',
              description: 'Send the unredacted content to the configured provider',
            },
          ],
        });
    if (sensitiveAction === 'cancel') {
      console.log(chalk.dim('\n  Commit cancelled.\n'));
      process.exit(0);
    }
    if (sensitiveAction === 'protect') diffForModel = protectedInput.diff;
  }

  // Prepare the diff the model sees (computed once — it doesn't change across
  // regenerations): lock-file and stripFiles contents are stubbed (they carry
  // no commit intent) and oversized diffs are condensed to a --stat summary
  // plus truncated hunks, so token spend stays proportional to what the
  // model needs.
  const strippedDiff = stripLockFileContent(diffForModel, config.stripFiles);
  const { diff: modelDiff, truncated } = condenseDiff(
    strippedDiff,
    config.maxDiffChars,
    getDiffStat(projectRoot),
    config.maxFileDiffChars,
  );
  if (truncated) {
    console.log(
      chalk.dim(
        `  (diff condensed for the model — ${strippedDiff.length} → ${modelDiff.length} chars)`,
      ),
    );
  }
  // ── 3. AI call + confirm (with regenerate loop) ────────────────────

  let message, elapsed, usage, reasoningText;
  let regenerateCount = 0;

  while (true) {
    const spinner = ora({
      text: chalk.dim(`Calling ${chalk.bold(sanitizeTerminalText(config.modelId))} ...`),
      color: 'cyan',
    }).start();
    let liveReasoning;
    const stream = reasoningEnabled
      ? {
          onReasoningDelta(chunk) {
            if (!liveReasoning) {
              spinner.stop();
              liveReasoning = startReasoningStream(config.reasoning.maxDisplayChars, chunk);
              return;
            }
            liveReasoning.append(chunk);
          },
        }
      : null;

    // Ctrl+C while the model call is in flight cancels the commit cleanly:
    // stop the spinner (restoring the cursor) and exit, instead of dying
    // mid-frame with a half-drawn spinner line.
    const cancelOnSigint = () => {
      spinner.stop();
      console.log(chalk.dim('\n  Commit cancelled.\n'));
      process.exit(130); // 128 + SIGINT
    };
    process.on('SIGINT', cancelOnSigint);

    try {
      // Pass the previous message so a regenerate can ask for a rewording
      // instead of re-sending the full diff (see generateCommitMessage).
      ({
        message,
        elapsed,
        usage,
        reasoning: reasoningText,
      } = await generateCommitMessage(config, modelDiff, regenerateCount, message, stream));
      if (liveReasoning) await liveReasoning.stop();
      let done = `Generated in ${chalk.bold(formatMs(elapsed))}`;
      if (usage) done += chalk.dim(`  · tokens: ${formatUsage(usage)}`);
      spinner.succeed(done);
    } catch (err) {
      if (liveReasoning) await liveReasoning.stop();
      spinner.fail(chalk.red('API call failed'));
      console.log(`\n  ${indentError(err)}\n`);
      // A transient API failure shouldn't kill the session — let the user
      // retry, fall back to the previous message (if any), or cancel.
      if (yes) throw err;
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
    } finally {
      process.removeListener('SIGINT', cancelOnSigint);
    }

    if (!message) {
      console.log('\n  ' + chalk.red('✗ Empty response from AI.\n'));
      process.exit(1);
    }

    // ── 4. User action ─────────────────────────────────────────────────

    const action = yes
      ? 'use'
      : await confirmAction(
          message,
          reasoningEnabled
            ? {
                text: reasoningText,
                maxChars: config.reasoning.maxDisplayChars,
              }
            : null,
        );

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

  if (dryRun) {
    const restored = indexTransaction ? indexTransaction.restore() : true;
    indexTransaction = null;
    if (!restored) {
      console.log(
        '  ' + chalk.yellow('⚠ The Git index changed during the run and was left untouched.'),
      );
    }
    console.log(
      '  ' +
        chalk.green.bold(
          '✓ Dry run complete — no commit was created and tool-owned staging was restored.\n',
        ),
    );
    return;
  }

  if (getIndexFingerprint(projectRoot) !== plannedIndexFingerprint) {
    const restored = indexTransaction ? indexTransaction.restore() : false;
    indexTransaction = null;
    console.log(
      '  ' + chalk.red('✗ The staged changes changed after message generation; commit aborted.'),
    );
    if (restored)
      console.log(chalk.dim('  Tool-owned staging was restored to its original state.'));
    else
      console.log(
        chalk.dim('  The current index was left untouched to avoid overwriting concurrent work.'),
      );
    console.log(chalk.dim('  Review the changes and run aicommit again.\n'));
    process.exitCode = 1;
    return;
  }

  try {
    gitCommit(message, projectRoot);
    indexTransaction?.release();
    indexTransaction = null;
    console.log('\n  ' + chalk.green.bold('✓ Done!\n'));
  } catch (err) {
    const restored = indexTransaction ? indexTransaction.restore() : false;
    indexTransaction = null;
    console.log('\n  ' + chalk.red(`✗ Git commit failed: ${sanitizeTerminalText(err.message)}`));
    if (restored)
      console.log(chalk.dim('  Tool-owned staging was restored to its original state.'));
    console.log(chalk.dim('  Resolve the Git or hook error, then run aicommit again.\n'));
    process.exitCode = 1;
  }
}
