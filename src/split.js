import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import chalk from 'chalk';
import ora from 'ora';
import editor from '@inquirer/editor';

import { getResponseText, generateCommitMessage } from './api.js';
import {
  getBranch, hasHead, runGit, readGit, stripLockFileContent, isLockFile,
  matchStripPattern, unifiedArg, protectSensitiveDiff, isSensitiveFile,
} from './git.js';
import {
  statusColor, statusIcon, highlightMessage, vimSelect, vimCheckbox, startReasoningStream,
} from './ui.js';
import {
  cleanCommitMessage, formatMs, formatUsage, indentError, sanitizeTerminalText,
  isValidCommitMessage,
} from './utils.js';

// ═══════════════════════════════════════════════════════════════════════════
// Split mode (--split): group changes into multiple logical commits
// ═══════════════════════════════════════════════════════════════════════════

// Cap the diff sent to the grouping call — the model only needs enough
// context to assign files to groups, not every line of a huge diff.
const SPLIT_MAX_DIFF_CHARS = 16000;

// Cap the number of files shown to the grouping call. A huge change (e.g.
// hundreds of vendored assets) would otherwise force the model to enumerate
// every path in its JSON reply — blowing past maxTokens and truncating the
// plan mid-array. Files beyond the cap are dropped from the prompt; any file
// the model does not list is swept into the catch-all group by normalizePlan.
const SPLIT_MAX_PLAN_FILES = 100;

// Condense a changed-file list for the grouping prompt: keep the first `cap`
// files and note the rest. The model is told the hidden files are collected
// automatically, so it never needs to enumerate a huge list — this keeps its
// reply small enough to stay within maxTokens. Files beyond the cap still
// reach the commit (via the catch-all group in normalizePlan); they just
// aren't shown to the model.
export function condenseFileList(files, cap = SPLIT_MAX_PLAN_FILES) {
  const shown = files.slice(0, cap);
  const hidden = files.length - shown.length;
  const list = shown.map((f) => `${f.status} ${f.path}`).join('\n');
  if (hidden <= 0) return list;
  return `${list}\n... and ${hidden} more files (not shown — they will be collected into a final catch-all commit)`;
}

// All changes: staged, unstaged and untracked (porcelain -z avoids quoting
// issues with special characters in paths). Runs at the repo root so paths
// are root-relative — executeSplit stages them from projectRoot.
export function getAllChangedFiles(cwd) {
  const out = readGit(['status', '--porcelain', '-z', '-uall'], cwd);
  if (!out) return [];
  const entries = out.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    // porcelain -z prints renames/copies as "<dest>\0<src>\0". Keep both
    // paths: committing only the destination would drop the source's
    // deletion. They are shown as one "src → dest" entry (so the model
    // groups them together) and carried in addPaths for git add/diff.
    if (status.includes('R') || status.includes('C')) {
      const dest = path;
      const src = entries[++i];
      files.push({ status: status.trim() || '?', path: `${src} → ${dest}`, addPaths: [src, dest] });
    } else {
      files.push({ status: status.trim() || '?', path, addPaths: [path] });
    }
  }
  return files;
}

// Diff of the final working-tree state. With HEAD, one diff against HEAD
// naturally includes staged and unstaged edits. On an unborn branch Git has
// no tree to compare against, so concatenate index-vs-empty and
// worktree-vs-index. This matters when a newly staged file is edited again:
// the planner must see the same latest content executeSplit will git add -A.
function getWorkingTreeDiff(projectRoot, head, contextLines, paths = []) {
  const u = unifiedArg(contextLines);
  const pathArgs = paths.length ? ['--', ...paths] : [];
  if (head) {
    return readGit(['diff', u, 'HEAD', ...pathArgs], projectRoot).trim();
  }

  const cached = readGit(['diff', u, '--cached', ...pathArgs], projectRoot).trim();
  const unstaged = readGit(['diff', u, ...pathArgs], projectRoot).trim();
  return [cached, unstaged].filter(Boolean).join('\n');
}

export function getSplitDiff(projectRoot, head, contextLines) {
  return getWorkingTreeDiff(projectRoot, head, contextLines);
}

// Fingerprint every tracked patch plus untracked file bytes. Split planning
// can spend minutes in the model/review loop; before execution we must ensure
// it still describes the exact worktree state that will be staged.
export function getSplitStateFingerprint(projectRoot, head, files = getAllChangedFiles(projectRoot)) {
  const hash = createHash('sha256');
  hash.update(readGit(['status', '--porcelain', '-z', '-uall'], projectRoot));
  if (head) {
    hash.update(readGit(['diff', '--binary', '--full-index', 'HEAD'], projectRoot));
  } else {
    hash.update(readGit(['diff', '--binary', '--full-index', '--cached'], projectRoot));
    hash.update(readGit(['diff', '--binary', '--full-index'], projectRoot));
  }

  const buffer = Buffer.alloc(64 * 1024);
  for (const file of files) {
    if (file.status !== '??' && file.status !== '?') continue;
    const path = file.addPaths?.[0] || file.path;
    hash.update(`\0${path}\0`);
    let fd;
    try {
      fd = openSync(join(projectRoot, path), 'r');
      let offset = 0;
      while (true) {
        const count = readSync(fd, buffer, 0, buffer.length, offset);
        if (!count) break;
        hash.update(buffer.subarray(0, count));
        offset += count;
      }
    } catch {
      hash.update('<unreadable>');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return hash.digest('hex');
}

// Ask the model to partition the changed files into logical commits.
// Returns the raw response text; parsing happens in parsePlan/normalizePlan.
export async function generateSplitPlan(config, files, diff, projectRoot, stream = null) {
  const { temperature, language, maxTokens, reasoning } = config;
  const t0 = performance.now();

  const langLine = language === 'zh' ? 'Write each commit message in Chinese (Simplified Chinese).' : 'Write each commit message in English.';

  const maxDiffChars = config.splitMaxDiffChars || SPLIT_MAX_DIFF_CHARS;
  const diffPart = buildSplitPlanningContext(
    projectRoot, files, diff, maxDiffChars, config.stripFiles,
  );

  const system = [
    'You are an expert at organizing git changes into small, atomic commits.',
    'Group the changed files into logical commits by feature or module.',
    'Rules:',
    '- Each group must represent ONE logical change and get a conventional commit message (feat, fix, chore, docs, refactor, test, style, perf, ci, build).',
    '- Give every message a short subject line; when the subject alone does not say it all, add a body of bullet lines (what changed and why), each starting with "- " — the same format the single-commit flow produces.',
    '- Assign EVERY file shown in the "Changed files:" list to exactly one group — do not leave any out. Only files marked "(not shown)" may be omitted; they are collected into a final catch-all commit automatically.',
    '- Do not invent files that are not in the "Changed files:" list above.',
    '- Prefer a few coherent groups over many tiny ones; use a single group if the changes are one logical unit.',
    '- Keep the JSON compact. The "body" field is optional and, when useful, must contain at most two short bullet lines.',
    '- ' + langLine,
    '- Output ONLY a JSON array like [{"subject":"feat: add login","body":"- add a login form\\n- add session handling","files":["a.js"]}], no markdown fences, no explanation. Newlines inside "body" are JSON-escaped (\\n).',
  ].join('\n');

  const maxPlanFiles = config.splitMaxPlanFiles || SPLIT_MAX_PLAN_FILES;
  const changedFiles = condenseFileList(files, maxPlanFiles);
  const user = `Changed files:\n${changedFiles}` + `\n\nDiff:\n\`\`\`diff\n${diffPart}\n\`\`\``;

  // Reuse the shared call + reasoning-follow-up path so reasoning models
  // (MiniMax M2.x, DeepSeek R1, OpenRouter reasoning models) that return
  // empty content work here just like in the single-commit flow.
  const { text, usage, reasoning: reasoningContent } = await getResponseText(
    config,
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature,
    reasoning?.mode === 'on'
      ? Math.max(maxTokens, reasoning.maxTokens || 4096)
      : Math.max(maxTokens, 4096),
    'Based on your analysis above, output ONLY the JSON array split plan as requested. ' +
      'Do not include any other text, explanation, or code fences. ' +
      'If this is a recovery after truncation, omit optional body fields and output only subject and files. ' +
      'Use the following list as the source of truth and assign every shown file exactly once:\n\n' +
      `Changed files:\n${changedFiles}`,
    stream,
    (response) => {
      try {
        parsePlan(response);
        return true;
      } catch {
        return false;
      }
    },
  );

  if (!text.trim()) {
    throw new Error('API returned an empty split plan.');
  }

  return { raw: text, elapsed: performance.now() - t0, usage, reasoning: reasoningContent };
}

// Extract the JSON array from the model's response (tolerates code fences
// and surrounding prose).
export function parsePlan(raw) {
  let text = raw.trim();
  const fence = text.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('[');
  if (start === -1) {
    throw new Error('the response contains no JSON array — the model returned prose instead of a split plan');
  }
  const end = text.lastIndexOf(']');
  if (end < start) {
    throw new Error('the response was truncated before the plan completed (no closing "]") — ' +
      'the change has too many files for the model to list within maxTokens. ' +
      'Raise "maxTokens" in your config, or add vendored/binary assets to "stripFiles" to shrink the plan.');
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
    const message = cleanCommitMessage(g.message);
    return isValidCommitMessage(message) ? message : '';
  }
  const subject = typeof g.subject === 'string' ? g.subject.trim() : '';
  const body = typeof g.body === 'string' ? g.body.trim() : '';
  if (!subject) return '';
  const message = body ? `${subject}\n\n${body}` : subject;
  return isValidCommitMessage(message) ? message : '';
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

// Resolve group file entries back to the real paths git can stage/diff.
// Renames are stored under a display path ("src → dest") but must be added
// under both paths, otherwise only the destination is committed and the
// source's deletion is left behind.
function expandPaths(groupFiles, allFiles) {
  const byDisplay = new Map(allFiles.map((f) => [f.path, f]));
  const out = [];
  for (const p of groupFiles) {
    const f = byDisplay.get(p);
    if (f && f.addPaths) out.push(...f.addPaths);
    else out.push(p);
  }
  return out;
}

function displayPlan(groups, allFiles) {
  const byPath = new Map(allFiles.map((f) => [f.path, f]));
  console.log('\n  ' + chalk.cyan.bold(`Split plan: ${groups.length} commit${groups.length > 1 ? 's' : ''}`));
  groups.forEach((g, i) => {
    const lines = g.message.split('\n');
    console.log(`\n  ${chalk.bold(`${i + 1}.`)} ${highlightMessage(lines[0])}`);
    for (const line of lines.slice(1)) {
      if (line.trim()) console.log(chalk.dim(`     ${sanitizeTerminalText(line)}`));
    }
    for (const p of g.files) {
      const status = (byPath.get(p)?.status || '?').charAt(0);
      const c = statusColor[status] || chalk.dim;
      const icon = statusIcon[status] || status;
      console.log(`     ${c(icon)} ${c(sanitizeTerminalText(p))}`);
    }
  });
  console.log('');
}

// Let the user edit the plan as JSON in their editor.
// Returns the normalized plan, or null to keep the current one.
async function editPlan(groups, allFiles, language) {
  const edited = await editor({
    message: 'Edit the split plan (save and close to apply, leave empty to keep the current plan)',
    default: JSON.stringify(groups, null, 2),
    postfix: '.json', // file extension — gives the editor JSON highlighting
    waitForUseInput: false,
  });

  if (!edited.trim()) return null;

  try {
    return normalizePlan(JSON.parse(edited), allFiles, language);
  } catch (err) {
    console.log('\n  ' + chalk.red(`✗ Invalid plan JSON: ${sanitizeTerminalText(err.message)} — keeping the current plan.\n`));
    return null;
  }
}

// Common binary formats — sending their bytes to the model as utf-8 garbage
// helps no one, so previews are skipped for these extensions.
const BINARY_FILE_RE = /\.(?:png|jpe?g|gif|webp|ico|icns|pdf|zip|gz|tgz|bz2|xz|7z|rar|mp[34]|mov|avi|woff2?|ttf|otf|eot|jar|class|so|dylib|dll|exe|bin|wasm|sqlite3?)$/i;

// Read at most maxBytes of a file for the new-file preview. Reads through a
// file descriptor instead of readFileSync so a huge untracked file (a build
// artifact, a dump) is never loaded into memory whole. Returns null for
// files containing NUL bytes (binary content a text preview can't help with).
function readFilePreview(path, maxBytes = 2000) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    const n = Math.min(size, maxBytes);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, 0);
    if (buf.includes(0)) return null;
    const text = buf.toString('utf-8');
    return size > maxBytes ? text + '\n... (truncated)' : text;
  } catch {
    return null; // unreadable file — the name alone still helps
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function truncateContext(text, budget, marker) {
  if (text.length <= budget) return text;
  if (budget <= marker.length) return marker.slice(0, budget);
  return text.slice(0, budget - marker.length) + marker;
}

// Build the bounded context used by the split planner. `git diff` never
// includes untracked files, so include small text previews explicitly. When
// tracked and untracked changes coexist, reserve up to 40% of the budget for
// new files so neither side can crowd the other out completely.
export function buildSplitPlanningContext(projectRoot, files, diff, maxChars, stripGlobs = []) {
  const tracked = stripLockFileContent(diff, stripGlobs);
  const previewParts = [];

  for (const file of files) {
    if (file.status !== '??' && file.status !== '?') continue;
    const path = file.addPaths?.[0] || file.path;
    if (isLockFile(path) || matchStripPattern(path, stripGlobs) || BINARY_FILE_RE.test(path)) continue;
    const preview = readFilePreview(join(projectRoot, path));
    if (preview) previewParts.push(`Untracked file preview: ${path}\n\`\`\`\n${preview}\n\`\`\``);
  }

  const rawPreviews = previewParts.join('\n\n');
  const previewBudget = tracked.trim() ? Math.floor(maxChars * 0.4) : maxChars;
  const previews = truncateContext(rawPreviews, previewBudget, '\n... (untracked previews truncated)');
  const separator = previews && tracked ? '\n\nTracked changes:\n' : '';
  const trackedBudget = Math.max(0, maxChars - previews.length - separator.length);
  const trackedPart = truncateContext(tracked, trackedBudget, '\n... (diff truncated)');

  return `${previews}${separator}${trackedPart}`;
}

// Diff limited to one group's files, used when regenerating that group's
// message. Untracked files never show up in git diff, so when the diff is
// empty feed the model the file names plus a content preview instead.
function getGroupDiff(projectRoot, head, group, allFiles, contextLines, stripGlobs) {
  const addPaths = expandPaths(group.files, allFiles);
  const diff = getWorkingTreeDiff(projectRoot, head, contextLines, addPaths);
  if (diff) return stripLockFileContent(diff, stripGlobs);

  const byPath = new Map(allFiles.map((f) => [f.path, f]));
  const parts = [];
  for (const p of group.files) {
    const status = byPath.get(p)?.status || '?';
    parts.push(`${status} ${p}`);
    if ((status === '??' || status === '?') && !isLockFile(p) && !matchStripPattern(p, stripGlobs) && !BINARY_FILE_RE.test(p)) {
      const preview = readFilePreview(join(projectRoot, p));
      if (preview) parts.push('```\n' + preview + '\n```');
    }
  }
  return 'Changed files (new files, no diff available):\n' + parts.join('\n');
}

// Stage everything (so untracked files are included), then commit the
// groups one by one: unstage all → add the group's files → commit.
// Note: if a file has both staged and unstaged changes, the whole file is
// committed in its group — file-level splitting cannot separate hunks.
export function executeSplit(groups, projectRoot, allFiles) {
  runGit(['add', '-A'], projectRoot);

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    console.log('  ' + chalk.dim(`[${i + 1}/${groups.length}] `) + highlightMessage(g.message.split('\n')[0]));
    try {
      // Re-check HEAD every round: the first commit creates HEAD, so an
      // unborn index only needs `git rm --cached .` on the first round and
      // `git reset` (which requires HEAD) from the second round on. Keeping
      // the initial `head` value here would re-run `git rm --cached .` and
      // turn every previously committed file into a deletion.
      if (hasHead(projectRoot)) runGit(['reset', '-q'], projectRoot);
      else runGit(['rm', '-r', '-q', '--cached', '.'], projectRoot);
      runGit(['add', '--', ...expandPaths(g.files, allFiles)], projectRoot);
      runGit(['commit', '-m', g.message], projectRoot, true);
    } catch (err) {
      // Re-stage the remaining groups' files so the user isn't left with an
      // empty index and can finish with plain `git commit` once the issue
      // (usually a hook) is resolved. Best effort — the working tree still
      // holds everything even if this add fails.
      const rest = groups.slice(i).flatMap((g) => expandPaths(g.files, allFiles));
      try { runGit(['add', '--', ...rest], projectRoot); } catch { /* best effort */ }
      console.log('\n  ' + chalk.red(`✗ Commit ${i + 1}/${groups.length} failed.`));
      console.log('  ' + chalk.red(sanitizeTerminalText(err.message)));
      console.log(chalk.dim(`  ${i} commit(s) already made. Remaining groups (files re-staged):`));
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
export async function splitFlow(config, projectRoot, { dryRun = false, yes = false } = {}) {
  const reasoningEnabled = config.reasoning.mode === 'on';
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

  const branch = getBranch(projectRoot);
  const head = hasHead(projectRoot);

  console.log('\n  ' + `✓ ${chalk.bold(allFiles.length)} files changed` + (branch ? chalk.dim(`  on ${branch}`) : '') + chalk.dim('  (split mode)'));
  for (const { status, path } of allFiles) {
    const c = statusColor[status.charAt(0)] || chalk.dim;
    const icon = statusIcon[status.charAt(0)] || status.charAt(0);
    console.log(`  ${c('  ' + icon)} ${c(sanitizeTerminalText(path))}`);
  }

  const plannedStateFingerprint = getSplitStateFingerprint(projectRoot, head, allFiles);
  const diff = getSplitDiff(projectRoot, head, config.diffContextLines);
  if (getSplitStateFingerprint(projectRoot, head, allFiles) !== plannedStateFingerprint) {
    console.log('\n  ' + chalk.red('✗ The working tree is being modified concurrently; split planning aborted.\n'));
    process.exitCode = 1;
    return true;
  }

  const protectedInput = protectSensitiveDiff(diff);
  const sensitivePaths = allFiles
    .flatMap((file) => file.addPaths || [file.path])
    .filter(isSensitiveFile);
  const sensitiveFindings = [
    ...protectedInput.findings,
    ...sensitivePaths.map((path) => `sensitive file: ${path}`),
  ].filter((item, index, all) => all.indexOf(item) === index);
  let planningDiff = diff;
  let planningConfig = config;
  let protectModelInput = false;
  if (sensitiveFindings.length) {
    console.log('\n  ' + chalk.yellow.bold('⚠ Potential sensitive data detected:'));
    for (const finding of sensitiveFindings) {
      console.log('    ' + chalk.yellow(sanitizeTerminalText(finding)));
    }
    const sensitiveAction = yes ? 'protect' : await vimSelect({
      message: 'How should aicommit handle the split-planning request?',
      choices: [
        {
          name: 'Send protected diff', value: 'protect',
          description: 'Omit sensitive files/private keys and redact detected credential values',
        },
        { name: 'Cancel', value: 'cancel', description: 'Do not send repository content' },
        {
          name: 'Send original diff', value: 'original',
          description: 'Send the unredacted content to the configured provider',
        },
      ],
    });
    if (sensitiveAction === 'cancel') {
      console.log(chalk.dim('\n  Split cancelled.\n'));
      process.exit(0);
    }
    if (sensitiveAction === 'protect') {
      protectModelInput = true;
      planningDiff = protectedInput.diff;
      const sensitiveBasenames = sensitivePaths.map((path) => path.replace(/\\/g, '/').split('/').pop());
      planningConfig = {
        ...config,
        stripFiles: [...new Set([...config.stripFiles, ...sensitiveBasenames])],
      };
    }
  }

  const spinner = ora({
    text: chalk.dim(`Calling ${chalk.bold(sanitizeTerminalText(config.modelId))} to plan commits ...`),
    color: 'cyan',
  }).start();
  let liveReasoning;
  const stream = reasoningEnabled ? {
    onReasoningDelta(chunk) {
      if (!liveReasoning) {
        spinner.stop();
        liveReasoning = startReasoningStream(config.reasoning.maxDisplayChars, chunk);
        return;
      }
      liveReasoning.append(chunk);
    },
  } : null;

  let raw, reasoningText;
  // Same Ctrl+C contract as the single-commit flow: interrupting the model
  // call cancels the split cleanly instead of leaving a half-drawn spinner.
  const cancelOnSigint = () => {
    spinner.stop();
    console.log(chalk.dim('\n  Split cancelled.\n'));
    process.exit(130); // 128 + SIGINT
  };
  process.on('SIGINT', cancelOnSigint);
  try {
    let elapsed, usage;
    ({ raw, elapsed, usage, reasoning: reasoningText } = await generateSplitPlan(
      planningConfig, allFiles, planningDiff, projectRoot, stream,
    ));
    if (liveReasoning) await liveReasoning.stop();
    let done = `Plan generated in ${chalk.bold(formatMs(elapsed))}`;
    if (usage) done += chalk.dim(`  · tokens: ${formatUsage(usage)}`);
    spinner.succeed(done);
  } catch (err) {
    if (liveReasoning) await liveReasoning.stop();
    spinner.fail(chalk.red('API call failed'));
    console.log(`\n  ${indentError(err)}\n`);
    process.exit(1);
  } finally {
    process.removeListener('SIGINT', cancelOnSigint);
  }

  let groups;
  try {
    groups = normalizePlan(parsePlan(raw), allFiles, config.language);
  } catch (err) {
    console.log('\n  ' + chalk.red(`✗ Failed to parse the AI's split plan: ${sanitizeTerminalText(err.message)}`));
    console.log(chalk.dim('  Raw response:\n    ' + sanitizeTerminalText(raw.slice(0, 400)).split('\n').join('\n    ') + '\n'));
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

    const action = yes ? (dryRun ? 'finish' : 'commit') : await vimSelect({
      message: 'Proceed with this split plan?',
      choices: [
        dryRun
          ? { name: 'Finish dry run', value: 'finish', description: 'Keep the reviewed plan without creating commits' }
          : { name: 'Commit all groups', value: 'commit', description: `Create ${groups.length} commits as shown` },
        { name: 'Regenerate a message', value: 'regenerate', description: 'Ask AI for a different message for one group' },
        { name: 'Edit plan', value: 'edit', description: 'Modify the plan (JSON) in your editor' },
        { name: 'Cancel', value: 'cancel', description: 'Abort without committing' },
      ],
    }, reasoningEnabled ? {
      text: reasoningText,
      maxChars: config.reasoning.maxDisplayChars,
    } : null);

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
        const rawGroupDiff = getGroupDiff(
          projectRoot, head, groups[idx], allFiles,
          config.diffContextLines, planningConfig.stripFiles,
        );
        const groupDiff = protectModelInput ? protectSensitiveDiff(rawGroupDiff).diff : rawGroupDiff;
        const rspinner = ora({
          text: chalk.dim(`Regenerating message for group ${idx + 1} ...`),
          color: 'cyan',
        }).start();
        let liveGroupReasoning;
        const groupStream = reasoningEnabled ? {
          onReasoningDelta(chunk) {
            if (!liveGroupReasoning) {
              rspinner.stop();
              liveGroupReasoning = startReasoningStream(config.reasoning.maxDisplayChars, chunk);
              return;
            }
            liveGroupReasoning.append(chunk);
          },
        } : null;
        const cancelRegenOnSigint = () => {
          rspinner.stop();
          console.log(chalk.dim('\n  Split cancelled.\n'));
          process.exit(130); // 128 + SIGINT
        };
        process.on('SIGINT', cancelRegenOnSigint);
        try {
          regenCounts[idx]++;
          const {
            message, elapsed, usage, reasoning,
          } = await generateCommitMessage(
            config, groupDiff, regenCounts[idx], groups[idx].message, groupStream,
          );
          if (liveGroupReasoning) await liveGroupReasoning.stop();
          let done = `Group ${idx + 1} regenerated in ${chalk.bold(formatMs(elapsed))}`;
          if (usage) done += chalk.dim(`  · tokens: ${formatUsage(usage)}`);
          rspinner.succeed(done);
          reasoningText = reasoning;
          groups[idx] = { ...groups[idx], message };
        } catch (err) {
          if (liveGroupReasoning) await liveGroupReasoning.stop();
          regenCounts[idx]--;
          rspinner.fail(chalk.red(`Group ${idx + 1} regenerate failed`));
          console.log(`\n  ${indentError(err)}\n`);
        } finally {
          process.removeListener('SIGINT', cancelRegenOnSigint);
        }
      }
      continue; // show the updated plan again
    }

    break; // commit, or finish the dry run
  }

  if (dryRun) {
    console.log('\n  ' + chalk.green.bold('✓ Dry run complete — no commits were created.\n'));
    return true;
  }

  if (getSplitStateFingerprint(projectRoot, head) !== plannedStateFingerprint) {
    console.log('\n  ' + chalk.red('✗ The working tree changed after split planning; no commits were created.'));
    console.log(chalk.dim('  Review the changes and run aicommit --split again.\n'));
    process.exitCode = 1;
    return true;
  }

  console.log('');
  const ok = executeSplit(groups, projectRoot, allFiles);
  if (ok) {
    console.log('\n  ' + chalk.green.bold(`✓ Done! Created ${groups.length} commits.\n`));
  } else {
    process.exitCode = 1;
  }
  return true;
}
