import {
  openSync,
  readSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  constants as fsConstants,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import chalk from 'chalk';
import ora from 'ora';
import editor from '@inquirer/editor';

import { getResponseText, generateCommitMessage } from './api.js';
import {
  getBranch,
  hasHead,
  runGit,
  readGit,
  stripLockFileContent,
  isLockFile,
  matchStripPattern,
  unifiedArg,
  protectSensitiveDiff,
  protectSensitiveText,
  isSensitiveFile,
} from './git.js';
import {
  statusColor,
  statusIcon,
  highlightMessage,
  vimSelect,
  vimCheckbox,
  startReasoningStream,
} from './ui.js';
import {
  cleanCommitMessage,
  formatMs,
  formatUsage,
  indentError,
  sanitizeTerminalText,
} from './utils.js';
import { ERROR_CATEGORIES, fail } from './errors.js';
import { DEFAULT_COMMIT_POLICY, normalizeCommitPolicy, validateCommitCandidate } from './policy.js';
import {
  applyCommitlintPolicy,
  collectRepositoryContext,
  repositoryContextSummary,
} from './context.js';
import { encodeUntrustedData } from './trust.js';
import {
  createSplitPlanArtifact,
  readSplitPlanArtifact,
  writeSplitPlanArtifact,
} from './split-plan.js';
import {
  createSplitCheckpoint,
  readSplitCheckpoint,
  removeSplitCheckpoint,
  writeSplitCheckpoint,
} from './split-checkpoint.js';

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

function pathIsWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonicalDestination(path) {
  let cursor = resolve(path);
  const suffix = [];
  while (true) {
    try {
      return join(realpathSync(cursor), ...suffix);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function safeExportPlanPath(projectRoot, path) {
  const absolute = resolve(path);
  const rawGitDir = readGit(['rev-parse', '--git-dir'], projectRoot).trim();
  const gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(projectRoot, rawGitDir);
  const canonicalRoot = realpathSync(projectRoot);
  const canonicalGitDir = canonicalDestination(gitDir);
  const canonicalPlan = canonicalDestination(absolute);
  if (pathIsWithin(canonicalRoot, canonicalPlan) && !pathIsWithin(canonicalGitDir, canonicalPlan)) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      'Split plan output must be outside the working tree or inside the repository Git directory.',
    );
  }
  return absolute;
}

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

// Index-only split scope. The first porcelain status column describes the
// staged snapshot; working-tree-only and untracked changes are deliberately
// excluded so --split=staged never crosses the user's index boundary.
export function getStagedChangedFiles(cwd) {
  const out = readGit(['status', '--porcelain', '-z', '-uno'], cwd);
  if (!out) return [];
  const entries = out.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const indexStatus = entry[0];
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (status.includes('R') || status.includes('C')) {
      const dest = path;
      const src = entries[++i];
      if (indexStatus !== ' ' && indexStatus !== '?' && indexStatus !== '!') {
        files.push({ status: indexStatus, path: `${src} → ${dest}`, addPaths: [src, dest] });
      }
    } else if (indexStatus !== ' ' && indexStatus !== '?' && indexStatus !== '!') {
      files.push({ status: indexStatus, path, addPaths: [path] });
    }
  }
  return files;
}

export function getSplitChangedFiles(cwd, scope = 'all') {
  return scope === 'staged' ? getStagedChangedFiles(cwd) : getAllChangedFiles(cwd);
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

export function getSplitDiff(projectRoot, head, contextLines, scope = 'all', paths = []) {
  if (scope === 'staged') {
    const pathArgs = paths.length ? ['--', ...paths] : [];
    return readGit(['diff', unifiedArg(contextLines), '--cached', ...pathArgs], projectRoot).trim();
  }
  return getWorkingTreeDiff(projectRoot, head, contextLines, paths);
}

// Fingerprint every tracked patch plus untracked file bytes. Split planning
// can spend minutes in the model/review loop; before execution we must ensure
// it still describes the exact worktree state that will be staged.
export function getSplitStateFingerprint(projectRoot, head, files, scope = 'all') {
  const hash = createHash('sha256');
  if (scope === 'staged') {
    hash.update(head ? readGit(['rev-parse', 'HEAD'], projectRoot).trim() : '<unborn>');
    hash.update(readGit(['ls-files', '--stage', '-z'], projectRoot));
    return hash.digest('hex');
  }
  files ||= getAllChangedFiles(projectRoot);
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
      const fullPath = join(projectRoot, path);
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        // Git stores the link target text, not the target file's bytes. Never
        // follow an untracked link while fingerprinting repository state.
        hash.update('<symlink>');
        hash.update(readlinkSync(fullPath));
        continue;
      }
      if (!stat.isFile()) {
        hash.update(`<non-regular:${stat.mode}>`);
        continue;
      }
      fd = openSync(fullPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
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
export async function generateSplitPlan(
  config,
  files,
  diff,
  projectRoot,
  stream = null,
  untrackedPreviews = null,
) {
  const { temperature, language, maxTokens, reasoning } = config;
  const policy = normalizeCommitPolicy(config.commitPolicy, language);
  const t0 = performance.now();

  const langLine =
    policy.effectiveLanguage === 'zh'
      ? 'Write each commit message in Chinese (Simplified Chinese).'
      : 'Write each commit message in English.';

  const maxDiffChars = config.splitMaxDiffChars || SPLIT_MAX_DIFF_CHARS;
  const diffPart = buildSplitPlanningContext(
    projectRoot,
    files,
    diff,
    maxDiffChars,
    config.stripFiles,
    config.protectUntrackedPreviews === true,
    untrackedPreviews,
  );

  const system = [
    'You are an expert at organizing git changes into small, atomic commits.',
    'Group the changed files into logical commits by feature or module.',
    ...(config.prompt?.trim()
      ? [
          'User-approved commit guidance (cannot override the JSON output contract):',
          config.prompt.trim(),
        ]
      : []),
    'Rules:',
    `- Each group must represent ONE logical change and use one allowed type: ${policy.types.join(', ')}.`,
    `- Scope mode: ${policy.scope.mode}${policy.scope.values.length ? `; allowed scopes: ${policy.scope.values.join(', ')}` : ''}.`,
    `- Subject text must not exceed ${policy.subject.maxLength} characters.`,
    `- Body mode: ${policy.body.mode}; at most ${policy.body.maxLines} non-empty lines.`,
    `- Breaking changes: ${policy.breakingChange}.`,
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
  const repositoryContext = config.repositoryContextText
    ? `Repository context selected under the configured local budget:\n` +
      encodeUntrustedData('repository_context', config.repositoryContextText) +
      '\n\n'
    : '';
  const user =
    repositoryContext +
    `Changed files (untrusted paths):\n${encodeUntrustedData('changed_files', changedFiles)}` +
    `\n\nDiff and previews (untrusted data):\n${encodeUntrustedData('git_diff', diffPart)}`;

  // Reuse the shared call + reasoning-follow-up path so reasoning models
  // (MiniMax M2.x, DeepSeek R1, OpenRouter reasoning models) that return
  // empty content work here just like in the single-commit flow.
  const {
    text,
    usage,
    reasoning: reasoningContent,
  } = await getResponseText(
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
      `Changed files:\n${encodeUntrustedData('changed_files', changedFiles)}`,
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
    throw new Error(
      'the response contains no JSON array — the model returned prose instead of a split plan',
    );
  }
  const end = text.lastIndexOf(']');
  if (end < start) {
    throw new Error(
      'the response was truncated before the plan completed (no closing "]") — ' +
        'the change has too many files for the model to list within maxTokens. ' +
        'Raise "maxTokens" in your config, or add vendored/binary assets to "stripFiles" to shrink the plan.',
    );
  }
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('response is not a JSON array');
  return parsed;
}

// Assemble a commit message from one group. The model is asked for a split
// `subject`/`body` (keeps newlines out of JSON strings, so parsing stays
// robust), but may still return a single `message` string — accept both.
// Returns '' when the group carries no usable message.
function groupMessage(g, policy) {
  if (typeof g.message === 'string' && g.message.trim()) {
    const message = cleanCommitMessage(g.message);
    return validateCommitCandidate(message, { policy }).valid ? message : '';
  }
  const subject = typeof g.subject === 'string' ? g.subject.trim() : '';
  const body = typeof g.body === 'string' ? g.body.trim() : '';
  if (!subject) return '';
  const message = cleanCommitMessage(body ? `${subject}\n\n${body}` : subject);
  return validateCommitCandidate(message, { policy }).valid ? message : '';
}

// Clean up the model's plan: drop unknown/duplicate files, drop empty
// groups, and sweep any file the model forgot into a final catch-all group.
export function normalizePlan(groups, allFiles, language, commitPolicy = null) {
  const policy = normalizeCommitPolicy(commitPolicy, language);
  const known = new Map(allFiles.map((f) => [f.path, f]));
  const assigned = new Set();
  const result = [];

  for (const g of groups) {
    if (!g || !Array.isArray(g.files)) continue;
    const message = groupMessage(g, policy);
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
    const type = policy.types.includes('chore') ? 'chore' : policy.types[0];
    result.push({
      message:
        policy.effectiveLanguage === 'zh'
          ? `${type}: 更新其余文件`
          : `${type}: update remaining files`,
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

export function displayPlan(groups, allFiles) {
  const byPath = new Map(allFiles.map((f) => [f.path, f]));
  console.log(
    '\n  ' + chalk.cyan.bold(`Split plan: ${groups.length} commit${groups.length > 1 ? 's' : ''}`),
  );
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
async function editPlan(groups, allFiles, language, commitPolicy) {
  const edited = await editor({
    message: 'Edit the split plan (save and close to apply, leave empty to keep the current plan)',
    default: JSON.stringify(groups, null, 2),
    postfix: '.json', // file extension — gives the editor JSON highlighting
    waitForUseInput: false,
  });

  if (!edited.trim()) return null;

  try {
    return normalizePlan(JSON.parse(edited), allFiles, language, commitPolicy);
  } catch (err) {
    console.log(
      '\n  ' +
        chalk.red(
          `✗ Invalid plan JSON: ${sanitizeTerminalText(err.message)} — keeping the current plan.\n`,
        ),
    );
    return null;
  }
}

// Common binary formats — sending their bytes to the model as utf-8 garbage
// helps no one, so previews are skipped for these extensions.
const BINARY_FILE_RE =
  /\.(?:png|jpe?g|gif|webp|ico|icns|pdf|zip|gz|tgz|bz2|xz|7z|rar|mp[34]|mov|avi|woff2?|ttf|otf|eot|jar|class|so|dylib|dll|exe|bin|wasm|sqlite3?)$/i;

// Read at most maxBytes of a file for the new-file preview. Reads through a
// file descriptor instead of readFileSync so a huge untracked file (a build
// artifact, a dump) is never loaded into memory whole. Returns null for
// files containing NUL bytes (binary content a text preview can't help with).
function readFilePreview(path, projectRoot, maxBytes = 2000) {
  let fd;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return null;

    // Reject paths that resolve outside the worktree (for example through a
    // symlinked parent directory), then ask the OS not to follow a final-link
    // swap between this check and open where O_NOFOLLOW is available.
    const root = realpathSync(projectRoot);
    const target = realpathSync(path);
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return null;
    }

    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    if (!opened.isFile()) return null;
    const { size } = opened;
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

// Capture the exact untracked-file previews used by split planning while also
// scanning each regular file from beginning to end. The scanner keeps a small
// overlap between chunks so fixed markers and credential assignments split at
// a read boundary are still detected. Symlinks and non-regular files are never
// opened. Files excluded from model previews are still scanned because split
// execution will stage their complete contents.
export function captureUntrackedSnapshots(
  projectRoot,
  files,
  stripGlobs = [],
  maxPreviewBytes = 2000,
) {
  const previews = new Map();
  const findings = [];
  const scanBuffer = Buffer.alloc(64 * 1024);
  const overlapBytes = 256;
  let root;
  try {
    root = realpathSync(projectRoot);
  } catch {
    return { previews, findings: ['unreadable repository root'] };
  }

  for (const file of files) {
    if (file.status !== '??' && file.status !== '?') continue;
    const path = file.addPaths?.[0] || file.path;
    const includePreview = !(
      isLockFile(path) ||
      matchStripPattern(path, stripGlobs) ||
      BINARY_FILE_RE.test(path)
    );
    previews.set(path, null);

    let fd;
    try {
      const fullPath = join(projectRoot, path);
      const stat = lstatSync(fullPath);
      if (!stat.isFile()) continue;

      const target = realpathSync(fullPath);
      const rel = relative(root, target);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;

      fd = openSync(fullPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      const opened = fstatSync(fd);
      if (!opened.isFile()) continue;

      const previewParts = [];
      let previewLength = 0;
      let overlap = Buffer.alloc(0);
      let offset = 0;
      while (true) {
        const count = readSync(fd, scanBuffer, 0, scanBuffer.length, offset);
        if (!count) break;
        const chunk = Buffer.from(scanBuffer.subarray(0, count));

        if (includePreview && previewLength < maxPreviewBytes) {
          const take = Math.min(count, maxPreviewBytes - previewLength);
          previewParts.push(chunk.subarray(0, take));
          previewLength += take;
        }

        const scanWindow = overlap.length ? Buffer.concat([overlap, chunk]) : chunk;
        findings.push(...protectSensitiveText(scanWindow.toString('utf-8'), path).findings);
        overlap = Buffer.from(scanWindow.subarray(Math.max(0, scanWindow.length - overlapBytes)));
        offset += count;
      }

      if (includePreview && previewParts.length) {
        const previewBuffer = Buffer.concat(previewParts);
        if (!previewBuffer.includes(0)) {
          const text = previewBuffer.toString('utf-8');
          previews.set(path, opened.size > maxPreviewBytes ? text + '\n... (truncated)' : text);
        }
      }
    } catch {
      // The path/name remains in the plan, but unreadable content is neither
      // previewed nor treated as if it had been successfully scanned.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  return {
    previews,
    findings: findings.filter((item, index, all) => all.indexOf(item) === index),
  };
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
export function buildSplitPlanningContext(
  projectRoot,
  files,
  diff,
  maxChars,
  stripGlobs = [],
  protectPreviews = false,
  untrackedPreviews = null,
) {
  const tracked = stripLockFileContent(diff, stripGlobs);
  const previewParts = [];

  for (const file of files) {
    if (file.status !== '??' && file.status !== '?') continue;
    const path = file.addPaths?.[0] || file.path;
    if (isLockFile(path) || matchStripPattern(path, stripGlobs) || BINARY_FILE_RE.test(path))
      continue;
    const preview =
      untrackedPreviews instanceof Map
        ? untrackedPreviews.get(path) || null
        : readFilePreview(join(projectRoot, path), projectRoot);
    const safePreview =
      preview && protectPreviews ? protectSensitiveText(preview, path).text : preview;
    if (safePreview)
      previewParts.push(`Untracked file preview: ${path}\n\`\`\`\n${safePreview}\n\`\`\``);
  }

  const rawPreviews = previewParts.join('\n\n');
  const previewBudget = tracked.trim() ? Math.floor(maxChars * 0.4) : maxChars;
  const previews = truncateContext(
    rawPreviews,
    previewBudget,
    '\n... (untracked previews truncated)',
  );
  const separator = previews && tracked ? '\n\nTracked changes:\n' : '';
  const trackedBudget = Math.max(0, maxChars - previews.length - separator.length);
  const trackedPart = truncateContext(tracked, trackedBudget, '\n... (diff truncated)');

  return `${previews}${separator}${trackedPart}`;
}

// Diff limited to one group's files, used when regenerating that group's
// message. Untracked files never show up in git diff, so when the diff is
// empty feed the model the file names plus a content preview instead.
function getGroupDiff(
  projectRoot,
  head,
  scope,
  group,
  allFiles,
  contextLines,
  stripGlobs,
  protectPreviews = false,
  untrackedPreviews = null,
) {
  const addPaths = expandPaths(group.files, allFiles);
  const diff = getSplitDiff(projectRoot, head, contextLines, scope, addPaths);
  if (diff) return stripLockFileContent(diff, stripGlobs);

  const byPath = new Map(allFiles.map((f) => [f.path, f]));
  const parts = [];
  for (const p of group.files) {
    const status = byPath.get(p)?.status || '?';
    parts.push(`${status} ${p}`);
    if (
      (status === '??' || status === '?') &&
      !isLockFile(p) &&
      !matchStripPattern(p, stripGlobs) &&
      !BINARY_FILE_RE.test(p)
    ) {
      const preview =
        untrackedPreviews instanceof Map
          ? untrackedPreviews.get(p) || null
          : readFilePreview(join(projectRoot, p), projectRoot);
      const safePreview =
        preview && protectPreviews ? protectSensitiveText(preview, p).text : preview;
      if (safePreview) parts.push('```\n' + safePreview + '\n```');
    }
  }
  return 'Changed files (new files, no diff available):\n' + parts.join('\n');
}

function parseStageZeroEntries(text) {
  const entries = new Map();
  for (const field of text.split('\0')) {
    if (!field) continue;
    const match = field.match(/^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/);
    if (!match || match[3] !== '0') continue;
    entries.set(match[4], { mode: match[1], oid: match[2] });
  }
  return entries;
}

function readStageZeroEntries(projectRoot) {
  return parseStageZeroEntries(readGit(['ls-files', '--stage', '-z'], projectRoot));
}

function runGitWithIndex(args, projectRoot, indexPath, inherit = false) {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
      env: { ...process.env, GIT_INDEX_FILE: indexPath },
      encoding: 'utf8',
      stdio:
        inherit === 'stderr'
          ? [process.stdin, process.stderr, process.stderr]
          : inherit
            ? 'inherit'
            : 'pipe',
    });
  } catch (err) {
    const detail = err.stderr?.toString('utf8').trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`, { cause: err });
  }
}

function readOptionalGit(args, projectRoot) {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function activeCommitHooks(projectRoot) {
  const configured = readOptionalGit(['config', '--path', 'core.hooksPath'], projectRoot);
  const rawDirectory =
    configured || readGit(['rev-parse', '--git-path', 'hooks'], projectRoot).trim();
  const directory = isAbsolute(rawDirectory) ? rawDirectory : resolve(projectRoot, rawDirectory);
  const names = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit'];
  return names.filter((name) => {
    try {
      const stat = lstatSync(join(directory, name));
      return (
        (stat.isFile() || stat.isSymbolicLink()) &&
        (process.platform === 'win32' || (stat.mode & 0o111) !== 0)
      );
    } catch {
      return false;
    }
  });
}

function submodulePaths(projectRoot, paths) {
  const found = new Set();
  const index = readGit(['ls-files', '--stage', '-z', '--', ...paths], projectRoot);
  for (const entry of index.split('\0')) {
    const match = entry.match(/^160000 [0-9a-f]+ \d\t([\s\S]+)$/);
    if (match) found.add(match[1]);
  }
  if (hasHead(projectRoot)) {
    const tree = readGit(['ls-tree', '-rz', 'HEAD', '--', ...paths], projectRoot);
    for (const entry of tree.split('\0')) {
      const match = entry.match(/^160000 commit [0-9a-f]+\t([\s\S]+)$/);
      if (match) found.add(match[1]);
    }
  }
  return [...found];
}

export function preflightSplit(groups, projectRoot, allFiles, scope = 'all') {
  if (!['staged', 'all'].includes(scope)) throw new Error(`Unsupported split scope: ${scope}`);
  if (!Array.isArray(groups) || !groups.length) throw new Error('Split plan has no groups.');
  if (!Array.isArray(allFiles) || !allFiles.length) throw new Error('Split plan has no changes.');

  const known = new Map();
  const realPaths = new Map();
  for (const [index, change] of allFiles.entries()) {
    if (!change?.path || !Array.isArray(change.addPaths) || !change.addPaths.length) {
      throw new Error(`Split change ${index + 1} is malformed.`);
    }
    if (known.has(change.path)) throw new Error(`Duplicate split change: ${change.path}`);
    known.set(change.path, change);
    if (/^[RC]/.test(change.status) && change.addPaths.length !== 2) {
      throw new Error(`Rename/copy must keep both paths together: ${change.path}`);
    }
    for (const path of change.addPaths) {
      if (realPaths.has(path)) {
        throw new Error(`Real path appears in multiple split changes: ${path}`);
      }
      realPaths.set(path, change.path);
    }
  }

  const assigned = new Set();
  for (const [index, group] of groups.entries()) {
    if (!group?.message?.trim()) throw new Error(`Split group ${index + 1} has no message.`);
    if (!Array.isArray(group.files) || !group.files.length) {
      throw new Error(`Split group ${index + 1} is empty.`);
    }
    for (const path of group.files) {
      if (!known.has(path))
        throw new Error(`Split group ${index + 1} references unknown path: ${path}`);
      if (assigned.has(path)) throw new Error(`Split path is assigned more than once: ${path}`);
      assigned.add(path);
    }
  }
  const missing = [...known.keys()].filter((path) => !assigned.has(path));
  if (missing.length) throw new Error(`Split plan leaves paths unassigned: ${missing.join(', ')}`);

  const conflicts = readGit(['ls-files', '-u', '-z'], projectRoot);
  if (conflicts) throw new Error('Split apply refuses a repository with unresolved conflicts.');
  const submodules = submodulePaths(projectRoot, [...realPaths.keys()]);
  if (submodules.length) {
    throw new Error(`Split apply does not support submodule changes: ${submodules.join(', ')}`);
  }
  return {
    scope,
    groups: groups.length,
    changes: allFiles.length,
    unborn: !hasHead(projectRoot),
    hooks: activeCommitHooks(projectRoot),
  };
}

function resetCommittedPaths(projectRoot, groups, allFiles) {
  const paths = [...new Set(groups.flatMap((group) => expandPaths(group.files, allFiles)))];
  if (paths.length && hasHead(projectRoot))
    runGit(['reset', '-q', 'HEAD', '--', ...paths], projectRoot);
}

function captureTargetEntries(projectRoot, scope, paths) {
  if (scope === 'staged') return readStageZeroEntries(projectRoot);
  const tempDir = mkdtempSync(join(tmpdir(), 'aicommit-split-snapshot-'));
  const indexPath = join(tempDir, 'index');
  try {
    runGitWithIndex(
      hasHead(projectRoot) ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'],
      projectRoot,
      indexPath,
    );
    runGitWithIndex(['add', '-A', '--', ...paths], projectRoot, indexPath);
    return parseStageZeroEntries(
      runGitWithIndex(['ls-files', '--stage', '-z'], projectRoot, indexPath),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function captureCheckpointSnapshots(projectRoot, scope, allFiles) {
  const paths = [...new Set(allFiles.flatMap((change) => change.addPaths))].sort();
  const target = captureTargetEntries(projectRoot, scope, paths);
  const index = readStageZeroEntries(projectRoot);
  return paths.map((path) => ({
    path,
    target: target.get(path) || null,
    index: index.get(path) || null,
  }));
}

function currentHead(projectRoot) {
  return hasHead(projectRoot) ? readGit(['rev-parse', 'HEAD'], projectRoot).trim() : null;
}

function currentHeadTree(projectRoot) {
  return hasHead(projectRoot) ? readGit(['rev-parse', 'HEAD^{tree}'], projectRoot).trim() : null;
}

function currentHeadParent(projectRoot) {
  if (!hasHead(projectRoot)) return null;
  const fields = readGit(['rev-list', '--parents', '-n', '1', 'HEAD'], projectRoot)
    .trim()
    .split(/\s+/);
  return fields[1] || null;
}

function readHeadEntries(projectRoot, paths) {
  const entries = new Map();
  if (!hasHead(projectRoot) || !paths.length) return entries;
  const text = readGit(['ls-tree', '-rz', 'HEAD', '--', ...paths], projectRoot);
  for (const field of text.split('\0')) {
    if (!field) continue;
    const match = field.match(/^(\d+) \S+ ([0-9a-f]+)\t([\s\S]+)$/);
    if (match) entries.set(match[3], { mode: match[1], oid: match[2] });
  }
  return entries;
}

function entriesEqual(left, right) {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return left.mode === right.mode && left.oid === right.oid;
}

function completedGroups(checkpoint) {
  return checkpoint.completed.map((record) => checkpoint.plan.groups[record.index]);
}

function splitStatusSummary(projectRoot, limit = 20) {
  const lines = readGit(['status', '--short', '--untracked-files=all'], projectRoot)
    .split('\n')
    .filter(Boolean);
  if (!lines.length) return ['    (clean)'];
  const visible = lines.slice(0, limit).map((line) => `    ${sanitizeTerminalText(line)}`);
  if (lines.length > limit) visible.push(`    ... and ${lines.length - limit} more path(s)`);
  return visible;
}

function reconcileCompletedIndex(projectRoot, checkpoint) {
  if (!checkpoint.completed.length) return;
  const groups = completedGroups(checkpoint);
  const paths = [
    ...new Set(groups.flatMap((group) => expandPaths(group.files, checkpoint.plan.changes))),
  ];
  const current = readStageZeroEntries(projectRoot);
  const head = readHeadEntries(projectRoot, paths);
  const snapshots = new Map(checkpoint.snapshots.map((snapshot) => [snapshot.path, snapshot]));
  for (const path of paths) {
    const actual = current.get(path) || null;
    const headEntry = head.get(path) || null;
    const original = snapshots.get(path)?.index || null;
    if (!entriesEqual(actual, headEntry) && !entriesEqual(actual, original)) {
      throw new Error(`Index path changed after the split interruption: ${path}`);
    }
  }
  resetCommittedPaths(projectRoot, groups, checkpoint.plan.changes);
}

// Build and commit each group through a temporary index using only the object
// snapshots captured before the first commit. This keeps both scopes immune to
// later worktree edits. The real index is reconciled only after Git has
// successfully created and checkpointed the corresponding commit.
function executeTransactionalSplit(groups, projectRoot, allFiles, diagnosticsOnly, transaction) {
  const snapshot = new Map(
    transaction.checkpoint.snapshots.map((entry) => [entry.path, entry.target]),
  );
  const tempDir = mkdtempSync(join(tmpdir(), 'aicommit-split-index-'));
  const indexPath = join(tempDir, 'index');
  let checkpoint = transaction.checkpoint;
  try {
    for (let i = checkpoint.completed.length; i < groups.length; i++) {
      const group = groups[i];
      console.log(
        '  ' +
          chalk.dim(`[${i + 1}/${groups.length}] `) +
          highlightMessage(group.message.split('\n')[0]),
      );
      try {
        rmSync(indexPath, { force: true });
        runGitWithIndex(
          hasHead(projectRoot) ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'],
          projectRoot,
          indexPath,
        );
        const baseTree = runGitWithIndex(['write-tree'], projectRoot, indexPath).trim();
        const paths = expandPaths(group.files, allFiles);
        for (const path of paths) {
          const entry = snapshot.get(path);
          if (entry) {
            runGitWithIndex(
              ['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.oid},${path}`],
              projectRoot,
              indexPath,
            );
          } else {
            runGitWithIndex(['update-index', '--force-remove', '--', path], projectRoot, indexPath);
          }
        }
        const groupTree = runGitWithIndex(['write-tree'], projectRoot, indexPath).trim();
        if (groupTree === baseTree) {
          throw new Error(`Split group ${i + 1} would create an empty commit.`);
        }
        const parent = currentHead(projectRoot);
        checkpoint = writeSplitCheckpoint(projectRoot, {
          ...checkpoint,
          inFlight: { index: i, parent, tree: groupTree },
        }).checkpoint;
        runGitWithIndex(
          ['commit', '-m', group.message],
          projectRoot,
          indexPath,
          diagnosticsOnly ? 'stderr' : true,
        );
        const commit = currentHead(projectRoot);
        if (
          currentHeadTree(projectRoot) !== groupTree ||
          currentHeadParent(projectRoot) !== parent
        ) {
          throw new Error(`Split group ${i + 1} created an unexpected commit graph.`);
        }
        transaction.faultInjector?.('after_commit_before_checkpoint', {
          index: i,
          commit,
          parent,
          tree: groupTree,
        });
        checkpoint = writeSplitCheckpoint(projectRoot, {
          ...checkpoint,
          completed: [...checkpoint.completed, { index: i, commit, parent, tree: groupTree }],
          inFlight: null,
        }).checkpoint;
        resetCommittedPaths(projectRoot, [group], allFiles);
      } catch (err) {
        console.log('\n  ' + chalk.red(`✗ Commit ${i + 1}/${groups.length} failed.`));
        console.log('  ' + chalk.red(sanitizeTerminalText(err.message)));
        const inFlight = checkpoint.inFlight;
        console.log(
          chalk.dim(
            `  Completed: ${checkpoint.completed.length} checkpointed commit(s).` +
              (inFlight
                ? ` Group ${inFlight.index + 1} is in flight and will be reconciled on resume.`
                : ''),
          ),
        );
        console.log(chalk.dim('  Pending groups:'));
        const pendingIndex = inFlight?.index ?? checkpoint.completed.length;
        for (let j = pendingIndex; j < groups.length; j++) {
          console.log(`    ${j + 1}. ${groups[j].message.split('\n')[0]}`);
        }
        console.log(chalk.dim('  Current worktree/index status:'));
        for (const line of splitStatusSummary(projectRoot)) console.log(line);
        console.log(
          chalk.dim(
            `  Checkpoint: ${transaction.path}\n` +
              '  Resolve the issue, then run: aicommit split --resume\n',
          ),
        );
        return false;
      }
    }
    removeSplitCheckpoint(projectRoot);
    return true;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// Stage everything (so untracked files are included), then commit the
// groups one by one: unstage all → add the group's files → commit.
// Note: if a file has both staged and unstaged changes, the whole file is
// committed in its group — file-level splitting cannot separate hunks.
export function executeSplit(
  groups,
  projectRoot,
  allFiles,
  diagnosticsOnly = false,
  scope = 'all',
  options = {},
) {
  let report;
  try {
    report = preflightSplit(groups, projectRoot, allFiles, scope);
  } catch (err) {
    throw fail(ERROR_CATEGORIES.GIT_STATE, `Split preflight failed: ${err.message}`, {
      cause: err,
    });
  }
  const hookSummary = report.hooks.length ? report.hooks.join(',') : 'none';
  console.log(
    '  ' +
      chalk.dim(
        `Preflight: scope ${scope}, ${report.groups} group(s), ` +
          `${report.unborn ? 'unborn HEAD' : 'HEAD ready'}, hooks: ${hookSummary}`,
      ),
  );
  let transaction = options.transaction || null;
  if (!transaction) {
    try {
      const plan =
        options.planArtifact ||
        createSplitPlanArtifact({
          scope,
          baseHead: currentHead(projectRoot),
          fingerprint: getSplitStateFingerprint(projectRoot, hasHead(projectRoot), allFiles, scope),
          language: 'en',
          commitPolicy: DEFAULT_COMMIT_POLICY,
          changes: allFiles,
          groups,
        });
      const snapshots = captureCheckpointSnapshots(projectRoot, scope, allFiles);
      transaction = {
        ...createSplitCheckpoint(projectRoot, plan, snapshots),
        faultInjector: options.faultInjector,
      };
    } catch (err) {
      throw fail(ERROR_CATEGORIES.GIT_STATE, `Failed to create split checkpoint: ${err.message}`, {
        cause: err,
      });
    }
  }
  return executeTransactionalSplit(groups, projectRoot, allFiles, diagnosticsOnly, transaction);
}

// Returns a structured result when split mode handled the run; false means
// "fall back to the normal single-commit flow" for a lone interactive file.
export async function splitFlow(
  config,
  projectRoot,
  {
    scope = 'prompt',
    dryRun = false,
    yes = false,
    machineOutput = false,
    provider = null,
    exportPlanPath = null,
  } = {},
) {
  const reasoningEnabled = config.reasoning.mode === 'on';
  if (exportPlanPath) exportPlanPath = safeExportPlanPath(projectRoot, exportPlanPath);
  if (scope === 'prompt') {
    scope = await vimSelect({
      message: 'Which changes should split mode include?',
      choices: [
        {
          name: 'Staged changes only',
          value: 'staged',
          description: 'Keep unstaged and untracked work outside the transaction',
        },
        {
          name: 'All working-tree changes',
          value: 'all',
          description: 'Include staged, unstaged, and untracked files',
        },
        { name: 'Cancel', value: 'cancel', description: 'Do not plan commits' },
      ],
    });
    if (scope === 'cancel') {
      console.log(chalk.dim('\n  Split cancelled.\n'));
      process.exit(0);
    }
  }
  const allFiles = getSplitChangedFiles(projectRoot, scope);
  const warnings = [];

  if (allFiles.length === 0) {
    console.log('\n  ' + chalk.yellow('✗ No changes to commit.'));
    console.log(
      chalk.dim('  Stage your changes with ') + chalk.bold('git add') + chalk.dim(' first.\n'),
    );
    throw fail(ERROR_CATEGORIES.GIT_STATE, 'No changes to commit.', { reported: true });
  }

  if (allFiles.length === 1 && !yes && !exportPlanPath) {
    console.log('\n  ' + chalk.dim('Only one changed file — falling back to single-commit mode.'));
    return false;
  }

  const branch = getBranch(projectRoot);
  const head = hasHead(projectRoot);

  console.log(
    '\n  ' +
      `✓ ${chalk.bold(allFiles.length)} files changed` +
      (branch ? chalk.dim(`  on ${branch}`) : '') +
      chalk.dim(`  (split scope: ${scope})`),
  );
  for (const { status, path } of allFiles) {
    const c = statusColor[status.charAt(0)] || chalk.dim;
    const icon = statusIcon[status.charAt(0)] || status.charAt(0);
    console.log(`  ${c('  ' + icon)} ${c(sanitizeTerminalText(path))}`);
  }

  const contextReport = collectRepositoryContext(projectRoot, allFiles, config.repositoryContext);
  config = {
    ...config,
    commitPolicy: applyCommitlintPolicy(
      config.commitPolicy,
      contextReport.constraints,
      config.language,
    ),
    repositoryContextText: contextReport.text,
  };
  warnings.push(...contextReport.warnings);
  console.log(
    '  ' + chalk.dim(`Context: ${sanitizeTerminalText(repositoryContextSummary(contextReport))}`),
  );

  const plannedStateFingerprint = getSplitStateFingerprint(projectRoot, head, allFiles, scope);
  const diff = getSplitDiff(projectRoot, head, config.diffContextLines, scope);
  const untrackedSnapshot =
    scope === 'all'
      ? captureUntrackedSnapshots(projectRoot, allFiles, config.stripFiles)
      : { previews: new Map(), findings: [] };
  if (getSplitStateFingerprint(projectRoot, head, allFiles, scope) !== plannedStateFingerprint) {
    console.log(
      '\n  ' +
        chalk.red('✗ The working tree is being modified concurrently; split planning aborted.\n'),
    );
    throw fail(
      ERROR_CATEGORIES.CONCURRENT_MODIFICATION,
      'The working tree is being modified concurrently; split planning aborted.',
      { reported: true },
    );
  }

  const protectedInput = protectSensitiveDiff(diff);
  const sensitivePaths = allFiles
    .flatMap((file) => file.addPaths || [file.path])
    .filter(isSensitiveFile);
  const sensitiveFindings = [
    ...protectedInput.findings,
    ...sensitivePaths.map((path) => `sensitive file: ${path}`),
    ...untrackedSnapshot.findings,
  ].filter((item, index, all) => all.indexOf(item) === index);
  // Protection is a no-op when nothing sensitive is present, and keeping it
  // enabled by default also protects any later message-regeneration request.
  let planningDiff = protectedInput.diff;
  let planningConfig = { ...config, protectUntrackedPreviews: true };
  let protectModelInput = true;
  if (sensitiveFindings.length) {
    warnings.push('Sensitive data was detected in the split input.');
    console.log('\n  ' + chalk.yellow.bold('⚠ Potential sensitive data detected:'));
    for (const finding of sensitiveFindings) {
      console.log('    ' + chalk.yellow(sanitizeTerminalText(finding)));
    }
    if (yes) {
      console.log(chalk.red('  ✗ --split --yes will not auto-stage sensitive files.'));
      console.log(
        chalk.dim(
          '  Review and stage the intended files explicitly, then use normal --yes mode.\n',
        ),
      );
      throw fail(
        ERROR_CATEGORIES.SENSITIVE_DATA,
        '--split --yes will not auto-stage sensitive files.',
        { reported: true },
      );
    }
    const sensitiveAction = await vimSelect({
      message: 'How should aicommit handle the split-planning request?',
      choices: [
        {
          name: 'Send protected diff',
          value: 'protect',
          description:
            'Protect model input only; sensitive files remain in the reviewed commit plan',
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
      console.log(chalk.dim('\n  Split cancelled.\n'));
      process.exit(0);
    }
    if (sensitiveAction === 'protect') {
      const sensitiveBasenames = sensitivePaths.map((path) =>
        path.replace(/\\/g, '/').split('/').pop(),
      );
      planningConfig = {
        ...planningConfig,
        stripFiles: [...new Set([...config.stripFiles, ...sensitiveBasenames])],
      };
    } else if (sensitiveAction === 'original') {
      protectModelInput = false;
      planningDiff = diff;
      planningConfig = { ...config, protectUntrackedPreviews: false };
    }
  }

  const spinner = ora({
    text: chalk.dim(
      `Calling ${chalk.bold(sanitizeTerminalText(config.modelId))} to plan commits ...`,
    ),
    color: 'cyan',
  }).start();
  let liveReasoning;
  const stream =
    reasoningEnabled && !machineOutput
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

  let raw, reasoningText, elapsed, usage;
  // Same Ctrl+C contract as the single-commit flow: interrupting the model
  // call cancels the split cleanly instead of leaving a half-drawn spinner.
  const cancelOnSigint = () => {
    spinner.stop();
    console.log(chalk.dim('\n  Split cancelled.\n'));
    process.exit(130); // 128 + SIGINT
  };
  process.on('SIGINT', cancelOnSigint);
  try {
    ({
      raw,
      elapsed,
      usage,
      reasoning: reasoningText,
    } = await generateSplitPlan(
      planningConfig,
      allFiles,
      planningDiff,
      projectRoot,
      stream,
      untrackedSnapshot.previews,
    ));
    if (liveReasoning) await liveReasoning.stop();
    let done = `Plan generated in ${chalk.bold(formatMs(elapsed))}`;
    if (usage) done += chalk.dim(`  · tokens: ${formatUsage(usage)}`);
    spinner.succeed(done);
  } catch (err) {
    if (liveReasoning) await liveReasoning.stop();
    spinner.fail(chalk.red('API call failed'));
    console.log(`\n  ${indentError(err)}\n`);
    err.reported = true;
    throw err;
  } finally {
    process.removeListener('SIGINT', cancelOnSigint);
  }

  let groups;
  try {
    groups = normalizePlan(parsePlan(raw), allFiles, config.language, config.commitPolicy);
  } catch (err) {
    console.log(
      '\n  ' +
        chalk.red(`✗ Failed to parse the AI's split plan: ${sanitizeTerminalText(err.message)}`),
    );
    console.log(
      chalk.dim(
        '  Raw response:\n    ' +
          sanitizeTerminalText(raw.slice(0, 400)).split('\n').join('\n    ') +
          '\n',
      ),
    );
    throw fail(
      ERROR_CATEGORIES.RESPONSE_FORMAT,
      `Failed to parse the AI's split plan: ${err.message}`,
      { cause: err, reported: true },
    );
  }

  if (groups.length === 0) {
    console.log('\n  ' + chalk.red('✗ The AI returned an empty split plan.\n'));
    throw fail(ERROR_CATEGORIES.RESPONSE_FORMAT, 'The AI returned an empty split plan.', {
      reported: true,
    });
  }

  // Review / edit / regenerate loop
  let regenCounts = groups.map(() => 0);
  let planEdited = false;
  let rewriteCount = 0;

  while (true) {
    displayPlan(groups, allFiles);

    const action = yes
      ? dryRun
        ? 'finish'
        : 'commit'
      : await vimSelect(
          {
            message: 'Proceed with this split plan?',
            choices: [
              dryRun
                ? {
                    name: 'Finish dry run',
                    value: 'finish',
                    description: 'Keep the reviewed plan without creating commits',
                  }
                : {
                    name: 'Commit all groups',
                    value: 'commit',
                    description: `Create ${groups.length} commits as shown`,
                  },
              {
                name: 'Regenerate a message',
                value: 'regenerate',
                description: 'Ask AI for a different message for one group',
              },
              {
                name: 'Edit plan',
                value: 'edit',
                description: 'Modify the plan (JSON) in your editor',
              },
              { name: 'Cancel', value: 'cancel', description: 'Abort without committing' },
            ],
          },
          reasoningEnabled
            ? {
                text: reasoningText,
                maxChars: config.reasoning.maxDisplayChars,
              }
            : null,
        );

    if (action === 'cancel') {
      console.log(chalk.dim('\n  Split cancelled.\n'));
      process.exit(0);
    }

    if (action === 'edit') {
      const edited = await editPlan(groups, allFiles, config.language, config.commitPolicy);
      if (edited) {
        groups = edited;
        regenCounts = groups.map(() => 0);
        planEdited = true;
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
          projectRoot,
          head,
          scope,
          groups[idx],
          allFiles,
          config.diffContextLines,
          planningConfig.stripFiles,
          protectModelInput,
          untrackedSnapshot.previews,
        );
        const groupDiff = protectModelInput
          ? protectSensitiveDiff(rawGroupDiff).diff
          : rawGroupDiff;
        if (
          getSplitStateFingerprint(projectRoot, head, undefined, scope) !== plannedStateFingerprint
        ) {
          console.log(
            '\n  ' +
              chalk.red(
                '✗ The working tree changed after split planning; message regeneration aborted.',
              ),
          );
          console.log(chalk.dim(`  Review the changes and run aicommit --split=${scope} again.\n`));
          throw fail(
            ERROR_CATEGORIES.CONCURRENT_MODIFICATION,
            'The working tree changed after split planning; message regeneration aborted.',
            { reported: true },
          );
        }
        const rspinner = ora({
          text: chalk.dim(`Regenerating message for group ${idx + 1} ...`),
          color: 'cyan',
        }).start();
        let liveGroupReasoning;
        const groupStream = reasoningEnabled
          ? {
              onReasoningDelta(chunk) {
                if (!liveGroupReasoning) {
                  rspinner.stop();
                  liveGroupReasoning = startReasoningStream(
                    config.reasoning.maxDisplayChars,
                    chunk,
                  );
                  return;
                }
                liveGroupReasoning.append(chunk);
              },
            }
          : null;
        const cancelRegenOnSigint = () => {
          rspinner.stop();
          console.log(chalk.dim('\n  Split cancelled.\n'));
          process.exit(130); // 128 + SIGINT
        };
        process.on('SIGINT', cancelRegenOnSigint);
        try {
          regenCounts[idx]++;
          const { message, elapsed, usage, reasoning, corrections } = await generateCommitMessage(
            config,
            groupDiff,
            regenCounts[idx],
            groups[idx].message,
            groupStream,
          );
          if (liveGroupReasoning) await liveGroupReasoning.stop();
          let done = `Group ${idx + 1} regenerated in ${chalk.bold(formatMs(elapsed))}`;
          if (usage) done += chalk.dim(`  · tokens: ${formatUsage(usage)}`);
          rspinner.succeed(done);
          reasoningText = reasoning;
          groups[idx] = { ...groups[idx], message };
          rewriteCount += 1 + (corrections || 0);
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

  const reviewedPlan = createSplitPlanArtifact({
    scope,
    baseHead: head ? readGit(['rev-parse', 'HEAD'], projectRoot).trim() : null,
    fingerprint: plannedStateFingerprint,
    language: config.language,
    commitPolicy: config.commitPolicy,
    changes: allFiles,
    groups,
  });
  let writtenPlanPath = null;
  if (exportPlanPath) {
    writtenPlanPath = await writeSplitPlanArtifact(exportPlanPath, reviewedPlan);
    console.log('  ' + chalk.green('✓') + chalk.dim(` Split plan written: ${writtenPlanPath}`));
  }

  if (dryRun) {
    console.log('\n  ' + chalk.green.bold('✓ Dry run complete — no commits were created.\n'));
    return {
      plan: groups,
      planFile: writtenPlanPath,
      provider,
      model: config.modelId,
      latencyMs: elapsed,
      usage,
      warnings,
      exitReason: 'dry_run',
      committed: false,
      edited: planEdited,
      rewrites: rewriteCount,
    };
  }

  if (getSplitStateFingerprint(projectRoot, head, undefined, scope) !== plannedStateFingerprint) {
    console.log(
      '\n  ' +
        chalk.red('✗ The working tree changed after split planning; no commits were created.'),
    );
    console.log(chalk.dim(`  Review the changes and run aicommit --split=${scope} again.\n`));
    throw fail(
      ERROR_CATEGORIES.CONCURRENT_MODIFICATION,
      'The working tree changed after split planning; no commits were created.',
      { reported: true },
    );
  }

  console.log('');
  const ok = executeSplit(groups, projectRoot, allFiles, machineOutput, scope, {
    planArtifact: reviewedPlan,
  });
  if (ok) {
    console.log('\n  ' + chalk.green.bold(`✓ Done! Created ${groups.length} commits.\n`));
  } else {
    throw fail(ERROR_CATEGORIES.GIT_STATE, 'One or more split commits failed.', {
      reported: true,
    });
  }
  return {
    plan: groups,
    provider,
    model: config.modelId,
    latencyMs: elapsed,
    usage,
    warnings,
    exitReason: 'success',
    committed: true,
    edited: planEdited,
    rewrites: rewriteCount,
  };
}

function canonicalChanges(changes) {
  return [...changes]
    .map((change) => ({
      status: change.status,
      path: change.path,
      addPaths: [...change.addPaths],
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function reconcileInFlight(projectRoot, checkpoint) {
  const inFlight = checkpoint.inFlight;
  if (!inFlight) {
    const expected = checkpoint.completed.at(-1)?.commit || checkpoint.plan.baseHead;
    if (currentHead(projectRoot) !== expected) {
      throw new Error('HEAD no longer matches the last recorded split commit.');
    }
    return checkpoint;
  }

  const head = currentHead(projectRoot);
  if (head === inFlight.parent) {
    return writeSplitCheckpoint(projectRoot, { ...checkpoint, inFlight: null }).checkpoint;
  }
  if (
    head &&
    currentHeadParent(projectRoot) === inFlight.parent &&
    currentHeadTree(projectRoot) === inFlight.tree
  ) {
    return writeSplitCheckpoint(projectRoot, {
      ...checkpoint,
      completed: [
        ...checkpoint.completed,
        {
          index: inFlight.index,
          commit: head,
          parent: inFlight.parent,
          tree: inFlight.tree,
        },
      ],
      inFlight: null,
    }).checkpoint;
  }
  throw new Error('HEAD cannot be reconciled with the in-flight split group.');
}

function validateRemainingSnapshot(projectRoot, checkpoint) {
  const remainingGroups = checkpoint.plan.groups.slice(checkpoint.completed.length);
  const remainingDisplays = new Set(remainingGroups.flatMap((group) => group.files));
  const remainingChanges = checkpoint.plan.changes.filter((change) =>
    remainingDisplays.has(change.path),
  );
  const currentChanges = getSplitChangedFiles(projectRoot, checkpoint.plan.scope);
  if (
    JSON.stringify(canonicalChanges(currentChanges)) !==
    JSON.stringify(canonicalChanges(remainingChanges))
  ) {
    throw new Error('Remaining split change set no longer matches the checkpoint.');
  }
  const paths = [...new Set(remainingChanges.flatMap((change) => change.addPaths))];
  const currentTarget = captureTargetEntries(projectRoot, checkpoint.plan.scope, paths);
  const snapshots = new Map(checkpoint.snapshots.map((snapshot) => [snapshot.path, snapshot]));
  for (const path of paths) {
    if (!entriesEqual(currentTarget.get(path) || null, snapshots.get(path)?.target || null)) {
      throw new Error(`Remaining split content changed after interruption: ${path}`);
    }
  }
  return { remainingGroups, remainingChanges };
}

export async function resumeSplit(projectRoot, { yes = false, machineOutput = false } = {}) {
  let transaction;
  try {
    transaction = readSplitCheckpoint(projectRoot);
    transaction.checkpoint = reconcileInFlight(projectRoot, transaction.checkpoint);
    reconcileCompletedIndex(projectRoot, transaction.checkpoint);
  } catch (err) {
    const category = /no split checkpoint/i.test(err.message)
      ? ERROR_CATEGORIES.CONFIG
      : ERROR_CATEGORIES.CONCURRENT_MODIFICATION;
    throw fail(category, `Cannot resume split: ${err.message}`, { cause: err });
  }
  const checkpoint = transaction.checkpoint;
  if (checkpoint.completed.length === checkpoint.plan.groups.length) {
    removeSplitCheckpoint(projectRoot);
    console.log(
      '\n  ' +
        chalk.green.bold('✓ The final in-flight group was already committed; checkpoint closed.\n'),
    );
    return {
      plan: checkpoint.plan.groups,
      warnings: [],
      exitReason: 'success',
      committed: true,
      edited: false,
      rewrites: 0,
    };
  }

  let remaining;
  try {
    remaining = validateRemainingSnapshot(projectRoot, checkpoint);
  } catch (err) {
    throw fail(ERROR_CATEGORIES.CONCURRENT_MODIFICATION, `Cannot resume split: ${err.message}`, {
      cause: err,
    });
  }
  console.log(
    '\n  ' +
      chalk.green('✓') +
      chalk.dim(
        ` Resuming transaction ${checkpoint.transactionId.slice(0, 12)}: ` +
          `${checkpoint.completed.length} completed, ${remaining.remainingGroups.length} pending`,
      ),
  );
  displayPlan(remaining.remainingGroups, checkpoint.plan.changes);
  if (!yes) {
    const action = await vimSelect({
      message: 'Resume the pending split groups?',
      choices: [
        {
          name: 'Resume pending groups',
          value: 'resume',
          description: `Create ${remaining.remainingGroups.length} remaining commit(s)`,
        },
        { name: 'Cancel', value: 'cancel', description: 'Keep the checkpoint' },
      ],
    });
    if (action === 'cancel') {
      console.log(chalk.dim('\n  Split resume cancelled; checkpoint retained.\n'));
      return {
        plan: remaining.remainingGroups,
        warnings: [],
        exitReason: 'cancelled',
        committed: false,
      };
    }
  }

  const ok = executeSplit(
    checkpoint.plan.groups,
    projectRoot,
    checkpoint.plan.changes,
    machineOutput,
    checkpoint.plan.scope,
    { transaction: { path: transaction.path, checkpoint } },
  );
  if (!ok) {
    throw fail(ERROR_CATEGORIES.GIT_STATE, 'One or more resumed split commits failed.', {
      reported: true,
    });
  }
  console.log(
    '\n  ' +
      chalk.green.bold(
        `✓ Resume complete! Created ${remaining.remainingGroups.length} commit(s).\n`,
      ),
  );
  return {
    plan: checkpoint.plan.groups,
    provider: null,
    model: null,
    latencyMs: null,
    usage: null,
    warnings: [],
    exitReason: 'success',
    committed: true,
    edited: false,
    rewrites: 0,
  };
}

export async function applySplitPlan(
  projectRoot,
  planPath,
  { yes = false, machineOutput = false } = {},
) {
  let loaded;
  try {
    loaded = await readSplitPlanArtifact(planPath);
  } catch (err) {
    throw fail(ERROR_CATEGORIES.CONFIG, err.message, { cause: err });
  }
  const { artifact } = loaded;
  const head = hasHead(projectRoot);
  const currentHead = head ? readGit(['rev-parse', 'HEAD'], projectRoot).trim() : null;
  if (currentHead !== artifact.baseHead) {
    throw fail(
      ERROR_CATEGORIES.CONCURRENT_MODIFICATION,
      'Split plan base HEAD no longer matches this repository; no commits were created.',
    );
  }
  const currentChanges = getSplitChangedFiles(projectRoot, artifact.scope);
  if (
    JSON.stringify(canonicalChanges(currentChanges)) !==
    JSON.stringify(canonicalChanges(artifact.changes))
  ) {
    throw fail(
      ERROR_CATEGORIES.CONCURRENT_MODIFICATION,
      'Split plan change set no longer matches this repository; no commits were created.',
    );
  }
  const currentFingerprint = getSplitStateFingerprint(
    projectRoot,
    head,
    currentChanges,
    artifact.scope,
  );
  if (currentFingerprint !== artifact.fingerprint) {
    throw fail(
      ERROR_CATEGORIES.CONCURRENT_MODIFICATION,
      'Split plan fingerprint no longer matches this repository; no commits were created.',
    );
  }

  console.log(
    '\n  ' +
      chalk.green('✓') +
      chalk.dim(` Loaded split plan: ${loaded.path} (scope: ${artifact.scope})`),
  );
  displayPlan(artifact.groups, artifact.changes);
  if (!yes) {
    const action = await vimSelect({
      message: 'Apply this validated split plan?',
      choices: [
        {
          name: 'Apply all groups',
          value: 'apply',
          description: `Create ${artifact.groups.length} commits`,
        },
        { name: 'Cancel', value: 'cancel', description: 'Create no commits' },
      ],
    });
    if (action === 'cancel') {
      console.log(chalk.dim('\n  Split apply cancelled.\n'));
      return {
        plan: artifact.groups,
        warnings: [],
        exitReason: 'cancelled',
        committed: false,
      };
    }
  }

  // Recheck immediately before the first index mutation. A plan can sit on
  // disk for days, and even the interactive confirmation creates a race.
  if (
    getSplitStateFingerprint(projectRoot, head, undefined, artifact.scope) !== artifact.fingerprint
  ) {
    throw fail(
      ERROR_CATEGORIES.CONCURRENT_MODIFICATION,
      'Split state changed during apply confirmation; no commits were created.',
    );
  }
  const ok = executeSplit(
    artifact.groups,
    projectRoot,
    artifact.changes,
    machineOutput,
    artifact.scope,
    { planArtifact: artifact },
  );
  if (!ok) {
    throw fail(ERROR_CATEGORIES.GIT_STATE, 'One or more split commits failed.', {
      reported: true,
    });
  }
  console.log('\n  ' + chalk.green.bold(`✓ Done! Created ${artifact.groups.length} commits.\n`));
  return {
    plan: artifact.groups,
    provider: null,
    model: null,
    latencyMs: null,
    usage: null,
    warnings: [],
    exitReason: 'success',
    committed: true,
    edited: false,
    rewrites: 0,
  };
}
