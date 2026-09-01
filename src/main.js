import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import chalk from 'chalk';

import { parseArgs } from './cli.js';
import { getProjectRoot, loadConfig } from './config.js';
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
import { generateCommitMessage } from './api.js';
import {
  statusColor,
  statusIcon,
  confirmAction,
  editMessage,
  isPromptQuitError,
  vimSelect,
  vimCheckbox,
} from './ui.js';
import {
  formatMs,
  maskApiKey,
  formatUsage,
  indentError,
  sanitizeTerminalText,
  stringifyConfigRedacted,
  redactSensitiveUrl,
} from './utils.js';
import { abortSplit, applySplitPlan, resumeSplit, splitFlow } from './split.js';
import { runModelTask } from './generation-ui.js';
import { runSetup } from './setup.js';
import { detectProviderType } from './providers.js';
import { ERROR_CATEGORIES, fail } from './errors.js';
import { runDoctor } from './doctor.js';
import { runConfigCommand } from './config-command.js';
import { generateCompletion } from './completion.js';
import { runPolicyCommand } from './policy-command.js';
import { runUpdate } from './update.js';
import {
  applyCommitlintPolicy,
  collectRepositoryContext,
  repositoryContextSummary,
} from './context.js';

function withUntrackedFiles(changes, untracked) {
  return [...changes, ...untracked.map((path) => ({ status: '?', path, addPaths: [path] }))];
}

function printChangeList(changes) {
  for (const { status, path } of changes) {
    const code = status.charAt(0);
    const c = statusColor[code] || chalk.dim;
    const icon = statusIcon[code] || code;
    console.log(`  ${c('  ' + icon)} ${c(sanitizeTerminalText(path))}`);
  }
}

async function pickPathsToStage(unstaged, untracked, message) {
  const picked = await vimCheckbox({
    message,
    choices: withUntrackedFiles(unstaged, untracked).map(({ status, path, addPaths }) => ({
      name: `${statusIcon[status.charAt(0)] || status.charAt(0)} ${sanitizeTerminalText(path)}`,
      value: addPaths,
    })),
  });
  return picked.flat();
}

async function runMain() {
  // ── CLI arguments ───────────────────────────────────────────────────

  const {
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
    completionShell,
    help,
    version,
  } = parseArgs();

  if (help || version) return { exitReason: help ? 'help' : 'version' };
  if (completionShell) {
    process.stdout.write(generateCompletion(completionShell));
    return { exitReason: 'completion' };
  }
  const machineOutput = output === 'json';
  if (machineOutput && !yes && !doctor && !configAction && !policyAction && !update) {
    throw fail(ERROR_CATEGORIES.CONFIG, '--output=json requires --yes for commit and split flows.');
  }

  if (update) return runUpdate({ machineOutput, debug });

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
      throw fail(ERROR_CATEGORIES.CONFIG, `'${targetPath}' is not a valid directory.`);
    }
  }

  if (configAction) {
    return runConfigCommand(configAction, {
      provider: cliProvider,
      model: cliModel,
      machineOutput,
    });
  }

  if (policyAction) {
    return runPolicyCommand(policyAction, {
      messageFile: policyMessageFile,
      range: policyRange,
      machineOutput,
    });
  }

  // ── Banner ──────────────────────────────────────────────────────────

  console.log('');
  console.log(
    '  ' + chalk.cyan.bold('⚡ aicommit ') + chalk.dim('AI-powered commit message generator'),
  );
  console.log('  ' + chalk.dim('─'.repeat(45)));
  console.log('  ' + chalk.dim(`Working directory: ${sanitizeTerminalText(process.cwd())}`));

  if (['apply', 'resume', 'abort'].includes(splitCommand)) {
    const projectRoot = getProjectRoot();
    if (!isGitRepo(projectRoot)) {
      throw fail(ERROR_CATEGORIES.GIT_STATE, `Not a git repository: ${process.cwd()}`);
    }
    if (splitCommand === 'resume') return resumeSplit(projectRoot, { yes, machineOutput });
    if (splitCommand === 'abort') return abortSplit(projectRoot, { yes, machineOutput });
    return applySplitPlan(projectRoot, splitPlanFile, { yes, machineOutput });
  }

  if (doctor) return runDoctor(cliProvider, cliModel);

  // ── 1. Config ───────────────────────────────────────────────────────

  const { config, projectRoot, loaded, providerName, modelName, teamPolicyPath } = await loadConfig(
    cliProvider,
    { model: cliModel },
  );
  const selectedProvider = providerName || detectProviderType(config.apiUrl, config.providerType);
  const warnings = [];

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

  if (cliLang && teamPolicyPath) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      `--lang cannot override the repository team policy at ${teamPolicyPath}.`,
    );
  }
  if (cliLang) config.language = cliLang;
  if (config.language !== 'zh' && config.language !== 'en') {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      `Invalid language: "${config.language}". Use "zh" or "en".`,
    );
  }
  if (cliLang) {
    config.commitPolicy = { ...config.commitPolicy, language: cliLang };
  }

  if (cliReasoning === 'off') {
    config.reasoning = { ...config.reasoning, mode: 'off' };
  } else if (cliReasoning) {
    config.reasoning = { ...config.reasoning, mode: 'on', effort: cliReasoning };
  }
  const reasoningEnabled = config.reasoning.mode === 'on';

  const viaCli = cliProvider || cliModel ? chalk.dim(' (via CLI)') : '';
  const modelLabel = `${providerName}/${modelName} (${config.modelId})`;
  console.log(
    '  ' + chalk.green('✓') + chalk.dim(` Model: ${sanitizeTerminalText(modelLabel)}${viaCli}`),
  );
  console.log(
    '  ' +
      chalk.green('✓') +
      chalk.dim(` Endpoint: ${sanitizeTerminalText(redactSensitiveUrl(config.apiUrl))}`),
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
    console.log(chalk.dim(`  cliModel:     ${cliModel || '(not set)'}`));
    console.log(
      chalk.dim(
        `  reasoning:    ${config.reasoning.mode === 'on' ? config.reasoning.effort : config.reasoning.mode}${cliReasoning ? ' (via CLI)' : ''}`,
      ),
    );
    console.log(chalk.dim(`  providerName: ${providerName || '(not set)'}`));
    console.log(chalk.dim(`  modelName:    ${modelName || '(not set)'}`));
    console.log(chalk.dim(`  split:        ${split}`));
    console.log(chalk.dim(`  dryRun:       ${dryRun}`));
    console.log(chalk.dim(`  yes:          ${yes}`));
    console.log(chalk.dim('  final config:'));
    for (const [key, value] of Object.entries(config)) {
      const display =
        key === 'apiKey'
          ? maskApiKey(value)
          : key === 'apiUrl'
            ? redactSensitiveUrl(value)
            : stringifyConfigRedacted(value);
      const truncated = display.length > 100 ? display.slice(0, 100) + '…' : display;
      console.log(chalk.dim(`    ${key}: ${truncated}`));
    }
  }

  // ── 2. Diff ─────────────────────────────────────────────────────────

  // All git helpers swallow errors and return empty output, so without this
  // guard a non-repo directory would be misreported as "no changes to commit".
  if (!isGitRepo(projectRoot)) {
    console.log('\n  ' + chalk.red(`✗ Not a git repository: ${process.cwd()}`));
    console.log(chalk.dim('  Run aicommit inside a git working tree.\n'));
    throw fail(ERROR_CATEGORIES.GIT_STATE, `Not a git repository: ${process.cwd()}`, {
      reported: true,
    });
  }

  if (split) {
    const handled = await splitFlow(config, projectRoot, {
      scope: split,
      dryRun,
      yes,
      machineOutput,
      provider: selectedProvider,
      exportPlanPath: splitCommand === 'plan' ? splitPlanFile : null,
    });
    if (handled) return handled === true ? { exitReason: 'success' } : handled;
    // Only one changed file — continue with the normal single-commit flow.
  }

  // Only staged changes are considered — the diff the model sees covers
  // exactly what `git commit` will commit. When nothing is staged but the
  // working tree has changes, the user is offered to stage all/some files
  // interactively instead of being sent away to run `git add` manually.
  // All git commands run at the repo root (projectRoot), even when aicommit
  // is invoked from a subdirectory.
  let indexTransaction = null;
  const finishCancelled = ({
    notice = 'Commit cancelled.',
    message = null,
    latencyMs = null,
    usage = null,
    edited = false,
    rewrites = 0,
  } = {}) => {
    const restored = indexTransaction ? indexTransaction.restore() : true;
    indexTransaction = null;
    if (!restored) {
      warnings.push('The Git index changed during the run and was left untouched.');
      console.log(
        '  ' + chalk.yellow('⚠ The Git index changed during the run and was left untouched.'),
      );
    }
    if (notice) console.log(chalk.dim(`\n  ${notice}\n`));
    return {
      message,
      provider: selectedProvider,
      model: config.modelId,
      latencyMs,
      usage,
      warnings,
      exitReason: 'cancelled',
      committed: false,
      edited,
      rewrites,
    };
  };
  const beginIndexTransaction = () => {
    indexTransaction ||= createIndexTransaction(projectRoot);
    return indexTransaction;
  };
  let diff = getStagedDiff(projectRoot, config.diffContextLines);
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
      throw fail(ERROR_CATEGORIES.GIT_STATE, 'No changes to commit.', { reported: true });
    }

    console.log('\n  ' + chalk.yellow(`✗ No staged changes — ${tips.join(', ')}.`));
    printChangeList(withUntrackedFiles(unstaged, untracked));
    console.log('');

    if (yes && !dryRun) {
      console.log(chalk.red('  ✗ --yes requires changes to be staged explicitly.'));
      console.log(
        chalk.dim('  Stage the intended files with git add, then run aicommit --yes again.\n'),
      );
      throw fail(ERROR_CATEGORIES.GIT_STATE, '--yes requires explicitly staged changes.', {
        reported: true,
      });
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
      return finishCancelled({
        notice: 'Cancelled — stage files with git add and run aicommit again.',
      });
    }

    let toStage = null; // null → stage everything
    if (stageAction === 'pick') {
      toStage = await pickPathsToStage(
        unstaged,
        untracked,
        'Select files to stage (space to select, enter to confirm)',
      );
      if (!toStage.length) {
        return finishCancelled({ notice: 'No files selected — nothing staged.' });
      }
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
      throw fail(ERROR_CATEGORIES.GIT_STATE, `Failed to stage files: ${err.message}`, {
        cause: err,
        reported: true,
      });
    }

    diff = getStagedDiff(projectRoot, config.diffContextLines);
    if (!diff) {
      console.log('\n  ' + chalk.yellow('✗ Nothing staged — no diff to commit.\n'));
      throw fail(ERROR_CATEGORIES.GIT_STATE, 'Nothing staged; no diff to commit.', {
        reported: true,
      });
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
    throw fail(
      ERROR_CATEGORIES.CONCURRENT_MODIFICATION,
      'The staged changes are being modified concurrently; commit aborted.',
      { reported: true },
    );
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

  printChangeList(changedFiles);

  const contextReport = collectRepositoryContext(
    projectRoot,
    changedFiles,
    config.repositoryContext,
  );
  config.commitPolicy = applyCommitlintPolicy(
    config.commitPolicy,
    contextReport.constraints,
    config.language,
  );
  config.repositoryContextText = contextReport.text;
  warnings.push(...contextReport.warnings);
  console.log(
    '  ' + chalk.dim(`Context: ${sanitizeTerminalText(repositoryContextSummary(contextReport))}`),
  );

  // Protect common secrets before any repository content leaves the machine.
  // The protected diff affects only the model request, never the actual index.
  const protectedInput = protectSensitiveDiff(diff);
  let diffForModel = diff;
  if (protectedInput.findings.length) {
    warnings.push('Sensitive data was detected and protected before the provider request.');
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
      return finishCancelled();
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
    warnings.push('The diff was condensed to fit the configured provider input limit.');
    console.log(
      chalk.dim(
        `  (diff condensed for the model — ${strippedDiff.length} → ${modelDiff.length} chars)`,
      ),
    );
  }
  // ── 3. AI call + confirm (with regenerate loop) ────────────────────

  let message, elapsed, usage, reasoningText, qualityWarnings, corrections;
  let regenerateCount = 0;
  let automaticCorrectionCount = 0;
  let wasEdited = false;

  while (true) {
    try {
      // Pass the previous message so a regenerate can ask for a rewording
      // instead of re-sending the full diff (see generateCommitMessage).
      ({
        message,
        elapsed,
        usage,
        reasoning: reasoningText,
        qualityWarnings,
        corrections,
      } = await runModelTask({
        spinnerText: `Calling ${chalk.bold(sanitizeTerminalText(config.modelId))} ...`,
        reasoning: config.reasoning,
        machineOutput,
        cancelMessage: 'Commit cancelled.',
        failureMessage: 'API call failed',
        task: (stream) =>
          generateCommitMessage(config, modelDiff, regenerateCount, message, stream),
        successMessage(result) {
          let done = `Generated in ${chalk.bold(formatMs(result.elapsed))}`;
          if (result.usage) done += chalk.dim(`  · tokens: ${formatUsage(result.usage)}`);
          return done;
        },
      }));
      automaticCorrectionCount += corrections || 0;
      for (const warning of qualityWarnings || []) {
        if (!warnings.includes(warning)) warnings.push(warning);
        console.log('  ' + chalk.yellow(`⚠ Quality check: ${sanitizeTerminalText(warning)}`));
      }
    } catch (err) {
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
      return finishCancelled({
        message,
        latencyMs: elapsed,
        usage,
        edited: wasEdited,
        rewrites: regenerateCount + automaticCorrectionCount,
      });
    }

    if (!message) {
      console.log('\n  ' + chalk.red('✗ Empty response from AI.\n'));
      throw fail(ERROR_CATEGORIES.RESPONSE_FORMAT, 'Empty response from AI.', {
        reported: true,
      });
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
        wasEdited = true;
        break; // proceed to commit with edited message
      }
      // User cancelled during edit — exit
      return finishCancelled({
        message,
        latencyMs: elapsed,
        usage,
        edited: wasEdited,
        rewrites: regenerateCount + automaticCorrectionCount,
      });
    }

    if (action === 'regenerate') {
      regenerateCount++;
      console.log(chalk.dim(`\n  ↻ Regenerating (attempt #${regenerateCount + 1})...`));
      continue;
    }

    // action === 'cancel'
    return finishCancelled({
      message,
      latencyMs: elapsed,
      usage,
      edited: wasEdited,
      rewrites: regenerateCount + automaticCorrectionCount,
    });
  }

  // ── 5. Commit ────────────────────────────────────────────────────────

  console.log('');

  if (dryRun) {
    const restored = indexTransaction ? indexTransaction.restore() : true;
    indexTransaction = null;
    if (!restored) {
      warnings.push('The Git index changed during the run and was left untouched.');
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
    return {
      message,
      provider: selectedProvider,
      model: config.modelId,
      latencyMs: elapsed,
      usage,
      warnings,
      exitReason: 'dry_run',
      committed: false,
      edited: wasEdited,
      rewrites: regenerateCount + automaticCorrectionCount,
    };
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
    throw fail(
      ERROR_CATEGORIES.CONCURRENT_MODIFICATION,
      'The staged changes changed after message generation; commit aborted.',
      { reported: true },
    );
  }

  try {
    gitCommit(message, projectRoot, machineOutput);
    indexTransaction?.release();
    indexTransaction = null;
    console.log('\n  ' + chalk.green.bold('✓ Done!\n'));
    return {
      message,
      provider: selectedProvider,
      model: config.modelId,
      latencyMs: elapsed,
      usage,
      warnings,
      exitReason: 'success',
      committed: true,
      edited: wasEdited,
      rewrites: regenerateCount + automaticCorrectionCount,
    };
  } catch (err) {
    const restored = indexTransaction ? indexTransaction.restore() : false;
    indexTransaction = null;
    console.log('\n  ' + chalk.red(`✗ Git commit failed: ${sanitizeTerminalText(err.message)}`));
    if (restored)
      console.log(chalk.dim('  Tool-owned staging was restored to its original state.'));
    console.log(chalk.dim('  Resolve the Git or hook error, then run aicommit again.\n'));
    throw fail(ERROR_CATEGORIES.GIT_STATE, `Git commit failed: ${err.message}`, {
      cause: err,
      reported: true,
    });
  }
}

export async function main() {
  try {
    return await runMain();
  } catch (error) {
    if (!isPromptQuitError(error)) throw error;
    console.log(chalk.dim('\n  Quit — no commit was created.\n'));
    return {
      warnings: [],
      exitReason: 'cancelled',
      committed: false,
      edited: false,
      rewrites: 0,
    };
  }
}
