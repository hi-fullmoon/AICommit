import { readFileSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';

import chalk from 'chalk';
import ora from 'ora';
import editor from '@inquirer/editor';

import { getResponseText, generateCommitMessage } from './api.js';
import { getBranch, hasHead, runGit, stripLockFileContent, isLockFile, matchStripPattern, unifiedArg } from './git.js';
import { statusColor, statusIcon, highlightMessage, vimSelect, vimCheckbox } from './ui.js';
import { cleanCommitMessage, formatMs, formatUsage, indentError } from './utils.js';

// ═══════════════════════════════════════════════════════════════════════════
// Split mode (--split): group changes into multiple logical commits
// ═══════════════════════════════════════════════════════════════════════════

// Cap the diff sent to the grouping call — the model only needs enough
// context to assign files to groups, not every line of a huge diff.
const SPLIT_MAX_DIFF_CHARS = 16000;

// All changes: staged, unstaged and untracked (porcelain -z avoids quoting
// issues with special characters in paths). Runs at the repo root so paths
// are root-relative — executeSplit stages them from projectRoot.
function getAllChangedFiles(cwd) {
  try {
    const out = execSync('git status --porcelain -z -uall', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      cwd,
    });
    if (!out) return [];
    const entries = out.split('\0').filter(Boolean);
    const files = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const status = entry.slice(0, 2);
      const path = entry.slice(3);
      // Renames/copies carry a second NUL-separated path — skip it
      if (status.includes('R') || status.includes('C')) i++;
      files.push({ status: status.trim() || '?', path });
    }
    return files;
  } catch {
    return [];
  }
}

// Diff of all tracked changes (staged + unstaged) against HEAD. Before the
// first commit there is no HEAD, so fall back to the staged diff.
function getSplitDiff(projectRoot, head, contextLines) {
  const args = head ? ['diff', unifiedArg(contextLines), 'HEAD'] : ['diff', unifiedArg(contextLines), '--cached'];
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return '';
  }
}

// Ask the model to partition the changed files into logical commits.
// Returns the raw response text; parsing happens in parsePlan/normalizePlan.
async function generateSplitPlan(config, files, diff) {
  const { temperature, language, maxTokens } = config;
  const t0 = performance.now();

  const langLine = language === 'zh' ? 'Write each commit message in Chinese (Simplified Chinese).' : 'Write each commit message in English.';

  const stripped = stripLockFileContent(diff, config.stripFiles);
  const truncated = stripped.length > SPLIT_MAX_DIFF_CHARS;
  const diffPart = truncated ? stripped.slice(0, SPLIT_MAX_DIFF_CHARS) + '\n... (diff truncated)' : stripped;

  const system = [
    'You are an expert at organizing git changes into small, atomic commits.',
    'Group the changed files into logical commits by feature or module.',
    'Rules:',
    '- Each group must represent ONE logical change and get a conventional commit message (feat, fix, chore, docs, refactor, test, style, perf, ci, build).',
    '- Give every message a short subject line; add a brief body (what changed and why) after a blank line unless the subject alone says it all.',
    '- Every changed file must appear in EXACTLY one group; do not invent files.',
    '- Prefer a few coherent groups over many tiny ones; use a single group if the changes are one logical unit.',
    '- ' + langLine,
    '- Output ONLY a JSON array like [{"subject":"feat: add login","body":"Add a login form and session handling.","files":["a.js"]}], no markdown fences, no explanation.',
  ].join('\n');

  const user = `Changed files:\n${files.map((f) => `${f.status} ${f.path}`).join('\n')}` + `\n\nDiff:\n\`\`\`diff\n${diffPart}\n\`\`\``;

  // Reuse the shared call + reasoning-follow-up path so reasoning models
  // (MiniMax M2.x, DeepSeek R1, OpenRouter reasoning models) that return
  // empty content work here just like in the single-commit flow.
  const { text, usage } = await getResponseText(
    config,
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature,
    Math.max(maxTokens, 2048),
    'Based on your analysis above, output ONLY the JSON array split plan as requested. ' +
      'Do not include any other text, explanation, or code fences.',
  );

  if (!text.trim()) {
    throw new Error('API returned an empty split plan.');
  }

  return { raw: text, elapsed: performance.now() - t0, usage };
}

// Extract the JSON array from the model's response (tolerates code fences
// and surrounding prose).
function parsePlan(raw) {
  let text = raw.trim();
  const fence = text.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('no JSON array found in the response');
  }
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('response is not a JSON array');
  return parsed;
}

// Assemble a commit message from one group. The model is asked for a split
// `subject`/`body` (keeps newlines out of JSON strings, so parsing stays
// robust), but may still return a single `message` string — accept both.
// Returns '' when the group carries no usable message.
function groupMessage(g) {
  if (typeof g.message === 'string' && g.message.trim()) {
    return cleanCommitMessage(g.message);
  }
  const subject = typeof g.subject === 'string' ? g.subject.trim() : '';
  const body = typeof g.body === 'string' ? g.body.trim() : '';
  if (!subject) return '';
  return body ? `${subject}\n\n${body}` : subject;
}

// Clean up the model's plan: drop unknown/duplicate files, drop empty
// groups, and sweep any file the model forgot into a final catch-all group.
export function normalizePlan(groups, allFiles, language) {
  const known = new Map(allFiles.map((f) => [f.path, f]));
  const assigned = new Set();
  const result = [];

  for (const g of groups) {
    if (!g || !Array.isArray(g.files)) continue;
    const message = groupMessage(g);
    if (!message) continue;
    const files = [];
    for (const p of g.files) {
      if (known.has(p) && !assigned.has(p)) {
        assigned.add(p);
        files.push(p);
      }
    }
    if (files.length) result.push({ message, files });
  }

  const leftover = allFiles.map((f) => f.path).filter((p) => !assigned.has(p));
  if (leftover.length) {
    result.push({
      message: language === 'zh' ? 'chore: 更新其余文件' : 'chore: update remaining files',
      files: leftover,
    });
  }

  return result;
}

function displayPlan(groups, allFiles) {
  const byPath = new Map(allFiles.map((f) => [f.path, f]));
  console.log('\n  ' + chalk.cyan.bold(`Split plan: ${groups.length} commit${groups.length > 1 ? 's' : ''}`));
  groups.forEach((g, i) => {
    const lines = g.message.split('\n');
    console.log(`\n  ${chalk.bold(`${i + 1}.`)} ${highlightMessage(lines[0])}`);
    for (const line of lines.slice(1)) {
      if (line.trim()) console.log(chalk.dim(`     ${line}`));
    }
    for (const p of g.files) {
      const status = (byPath.get(p)?.status || '?').charAt(0);
      const c = statusColor[status] || chalk.dim;
      const icon = statusIcon[status] || status;
      console.log(`     ${c(icon)} ${c(p)}`);
    }
  });
  console.log('');
}

// Let the user edit the plan as JSON in their editor.
// Returns the normalized plan, or null to keep the current one.
async function editPlan(groups, allFiles, language) {
  const edited = await editor({
    message: 'Edit the split plan (JSON array of {message, files})',
    default: JSON.stringify(groups, null, 2),
    postfix: 'Save and close to apply, or leave empty to keep the current plan.',
    waitForUseInput: false,
  });

  if (!edited.trim()) return null;

  try {
    return normalizePlan(JSON.parse(edited), allFiles, language);
  } catch (err) {
    console.log('\n  ' + chalk.red(`✗ Invalid plan JSON: ${err.message} — keeping the current plan.\n`));
    return null;
  }
}

// Diff limited to one group's files, used when regenerating that group's
// message. Untracked files never show up in git diff, so when the diff is
// empty feed the model the file names plus a content preview instead.
function getGroupDiff(projectRoot, head, group, allFiles, contextLines, stripGlobs) {
  const u = unifiedArg(contextLines);
  const args = head ? ['diff', u, 'HEAD', '--', ...group.files] : ['diff', u, '--cached', '--', ...group.files];
  try {
    const diff = execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
    if (diff) return stripLockFileContent(diff, stripGlobs);
  } catch {
    /* fall through to the file-list preview */
  }

  const byPath = new Map(allFiles.map((f) => [f.path, f]));
  const parts = [];
  for (const p of group.files) {
    const status = byPath.get(p)?.status || '?';
    parts.push(`${status} ${p}`);
    if ((status === '??' || status === '?') && !isLockFile(p) && !matchStripPattern(p, stripGlobs)) {
      try {
        const content = readFileSync(join(projectRoot, p), 'utf-8');
        const preview = content.length > 2000 ? content.slice(0, 2000) + '\n... (truncated)' : content;
        parts.push('```\n' + preview + '\n```');
      } catch {
        /* unreadable file — the name alone still helps */
      }
    }
  }
  return 'Changed files (new files, no diff available):\n' + parts.join('\n');
}

// Stage everything (so untracked files are included), then commit the
// groups one by one: unstage all → add the group's files → commit.
// Note: if a file has both staged and unstaged changes, the whole file is
// committed in its group — file-level splitting cannot separate hunks.
function executeSplit(groups, projectRoot, head) {
  runGit(['add', '-A'], projectRoot);

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    console.log('  ' + chalk.dim(`[${i + 1}/${groups.length}] `) + highlightMessage(g.message.split('\n')[0]));
    try {
      if (head) runGit(['reset', '-q'], projectRoot);
      else runGit(['rm', '-r', '-q', '--cached', '.'], projectRoot);
      runGit(['add', '--', ...g.files], projectRoot);
      runGit(['commit', '-m', g.message], projectRoot, true);
    } catch {
      console.log('\n  ' + chalk.red(`✗ Commit ${i + 1}/${groups.length} failed.`));
      console.log(chalk.dim(`  ${i} commit(s) already made. Remaining groups:`));
      for (let j = i; j < groups.length; j++) {
        console.log(`    ${j + 1}. ${groups[j].message.split('\n')[0]}`);
      }
      console.log(chalk.dim('  Resolve the issue and commit the rest manually.\n'));
      return false;
    }
  }
  return true;
}

// Returns true when the split flow ran to completion (or exited); false
// means "fall back to the normal single-commit flow".
export async function splitFlow(config, projectRoot) {
  const allFiles = getAllChangedFiles(projectRoot);

  if (allFiles.length === 0) {
    console.log('\n  ' + chalk.yellow('✗ No changes to commit.'));
    console.log(chalk.dim('  Stage your changes with ') + chalk.bold('git add') + chalk.dim(' first.\n'));
    process.exit(1);
  }

  if (allFiles.length === 1) {
    console.log('\n  ' + chalk.dim('Only one changed file — falling back to single-commit mode.'));
    return false;
  }

  const branch = getBranch();
  const head = hasHead(projectRoot);

  console.log('\n  ' + `✓ ${chalk.bold(allFiles.length)} files changed` + (branch ? chalk.dim(`  on ${branch}`) : '') + chalk.dim('  (split mode)'));
  for (const { status, path } of allFiles) {
    const c = statusColor[status.charAt(0)] || chalk.dim;
    const icon = statusIcon[status.charAt(0)] || status.charAt(0);
    console.log(`  ${c('  ' + icon)} ${c(path)}`);
  }

  const diff = getSplitDiff(projectRoot, head, config.diffContextLines);

  const spinner = ora({
    text: chalk.dim(`Calling ${chalk.bold(config.modelId)} to plan commits ...`),
    color: 'cyan',
  }).start();

  let raw;
  try {
    let elapsed, usage;
    ({ raw, elapsed, usage } = await generateSplitPlan(config, allFiles, diff));
    let done = `Plan generated in ${chalk.bold(formatMs(elapsed))}`;
    if (usage) done += chalk.dim(`  · tokens: ${formatUsage(usage)}`);
    spinner.succeed(done);
  } catch (err) {
    spinner.fail(chalk.red('API call failed'));
    console.log(`\n  ${indentError(err)}\n`);
    process.exit(1);
  }

  let groups;
  try {
    groups = normalizePlan(parsePlan(raw), allFiles, config.language);
  } catch (err) {
    console.log('\n  ' + chalk.red(`✗ Failed to parse the AI's split plan: ${err.message}`));
    console.log(chalk.dim('  Raw response:\n    ' + raw.slice(0, 400).split('\n').join('\n    ') + '\n'));
    process.exit(1);
  }

  if (groups.length === 0) {
    console.log('\n  ' + chalk.red('✗ The AI returned an empty split plan.\n'));
    process.exit(1);
  }

  // Review / edit / regenerate loop
  let regenCounts = groups.map(() => 0);

  while (true) {
    displayPlan(groups, allFiles);

    const action = await vimSelect({
      message: 'Proceed with this split plan?',
      choices: [
        { name: 'Commit all groups', value: 'commit', description: `Create ${groups.length} commits as shown` },
        { name: 'Regenerate a message', value: 'regenerate', description: 'Ask AI for a different message for one group' },
        { name: 'Edit plan', value: 'edit', description: 'Modify the plan (JSON) in your editor' },
        { name: 'Cancel', value: 'cancel', description: 'Abort without committing' },
      ],
    });

    if (action === 'cancel') {
      console.log(chalk.dim('\n  Split cancelled.\n'));
      process.exit(0);
    }

    if (action === 'edit') {
      const edited = await editPlan(groups, allFiles, config.language);
      if (edited) {
        groups = edited;
        regenCounts = groups.map(() => 0);
      }
      continue; // show the (possibly updated) plan again
    }

    if (action === 'regenerate') {
      const picked = await vimCheckbox({
        message: 'Regenerate which commit messages? (space to select, enter to confirm)',
        choices: groups.map((g, i) => ({
          // checkbox rows are single-line — show the subject only
          name: `${i + 1}. ${g.message.split('\n')[0]}`,
          value: i,
        })),
      });

      for (const idx of picked) {
        const groupDiff = getGroupDiff(projectRoot, head, groups[idx], allFiles, config.diffContextLines, config.stripFiles);
        const rspinner = ora({
          text: chalk.dim(`Regenerating message for group ${idx + 1} ...`),
          color: 'cyan',
        }).start();
        try {
          regenCounts[idx]++;
          const { message, elapsed, usage } = await generateCommitMessage(config, groupDiff, regenCounts[idx]);
          let done = `Group ${idx + 1} regenerated in ${chalk.bold(formatMs(elapsed))}`;
          if (usage) done += chalk.dim(`  · tokens: ${formatUsage(usage)}`);
          rspinner.succeed(done);
          groups[idx] = { ...groups[idx], message };
        } catch (err) {
          regenCounts[idx]--;
          rspinner.fail(chalk.red(`Group ${idx + 1} regenerate failed`));
          console.log(`\n  ${indentError(err)}\n`);
        }
      }
      continue; // show the updated plan again
    }

    break; // commit
  }

  console.log('');
  const ok = executeSplit(groups, projectRoot, head);
  if (ok) {
    console.log('\n  ' + chalk.green.bold(`✓ Done! Created ${groups.length} commits.\n`));
  }
  return true;
}
