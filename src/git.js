import { execFileSync } from 'node:child_process';

// Big repos can produce multi-MB diffs; raise the default 1MB child-process
// buffer and surface a contextual error if the explicit limit is exceeded.
const MAX_BUFFER = 64 * 1024 * 1024;

// Run a read-only git command and preserve the distinction between "no
// output" and "git failed". Returning an empty string for both cases makes an
// invalid index, a permissions error, or a too-large response look like a
// clean working tree.
export function readGit(args, cwd, maxBuffer = MAX_BUFFER) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer,
      cwd,
    });
  } catch (err) {
    const detail = typeof err.stderr === 'string'
      ? err.stderr.trim()
      : err.stderr?.toString('utf-8').trim();
    const suffix = detail ? `: ${detail}` : '';
    throw new Error(`git ${args.join(' ')} failed${suffix}`, { cause: err });
  }
}

// --name-status -z emits status/path fields separated by NUL bytes. Unlike
// the default line-oriented format, paths are never C-quoted, so Unicode,
// tabs, newlines, and quotes remain safe to pass back to git as argv values.
function parseNameStatusZ(output) {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const files = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (!status) continue;
    const first = fields[i++];
    if (first === undefined) throw new Error('Unexpected truncated output from git --name-status -z.');
    if (status.startsWith('R') || status.startsWith('C')) {
      const second = fields[i++];
      if (second === undefined) throw new Error('Unexpected truncated rename output from git --name-status -z.');
      files.push({ status, path: `${first} → ${second}`, addPaths: [first, second] });
    } else {
      files.push({ status, path: first, addPaths: [first] });
    }
  }
  return files;
}

// git diff context lines around each hunk (--unified=<n>). Fewer context
// lines = fewer tokens for the model; commit messages rarely need git's
// default of 3. Falls back to 1 (the configured default) for anything that
// isn't a non-negative int.
export function unifiedArg(contextLines) {
  const n = Number.isInteger(contextLines) && contextLines >= 0 ? contextLines : 1;
  return `--unified=${n}`;
}

// Only the staged diff is considered, so the model sees exactly what
// `git commit` will commit (staging happens up front, interactively, when
// nothing is staged yet). Returns '' when nothing is staged.
export function getStagedDiff(cwd, contextLines) {
  return readGit(['diff', unifiedArg(contextLines), '--staged'], cwd).trim();
}

// Compact one-line-per-file summary of the same staged changes getStagedDiff
// returns. Used to prepend context when a diff is condensed, so the model
// still sees the full change scope without paying for every hunk.
export function getDiffStat(cwd) {
  return readGit(['diff', '--stat', '--staged'], cwd).trim();
}

// Lock files only record resolved dependency versions — their content carries
// no commit intent, and a package-lock.json bump can be tens of thousands of
// lines. Matching by basename (case-insensitive) covers them at any depth.
const LOCK_FILE_RE = /^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock|bun\.lockb|gemfile\.lock|go\.sum|cargo\.lock|composer\.lock|poetry\.lock|pipfile\.lock|uv\.lock|deno\.lock|gradle\.lockfile|.*\.terraform\.lock\.hcl)$/i;

export function isLockFile(path) {
  const base = (path || '').split('/').pop() || path;
  return LOCK_FILE_RE.test(base);
}

// Match a path against a user-supplied strip pattern ("stripFiles" config).
// Patterns match the basename case-insensitively; "*" matches any run of
// characters and "?" a single one (e.g. "*.min.js", "*.map", "*.snap").
// Generated artifacts like these carry no commit intent but can be huge.
export function matchStripPattern(path, patterns) {
  const base = (path || '').split('/').pop() || path;
  return (patterns || []).some((glob) => {
    if (typeof glob !== 'string' || !glob) return false;
    const re = new RegExp(
      '^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      'i',
    );
    return re.test(base);
  });
}

// Paths on a "diff --git a/x b/y" header line, unquoted and without the a/ b/
// prefix. Handles git's C-style quoting of paths that contain spaces.
function diffSectionPaths(line) {
  const rest = line.replace(/^diff --git\s+/, '');
  const parts = rest.match(/(?:"[^"]*"|\S+)/g) || [];
  return parts.map(p => p.replace(/^"|"$/g, '').replace(/^[ab]\//, ''));
}

// Replace the body of every lock-file (and "stripFiles"-matched) section in
// a raw git diff with a short stub, keeping only the "diff --git" header so
// the model still sees that the file changed. git diff sections begin at
// lines starting with "diff --git".
export function stripLockFileContent(diff, stripGlobs = []) {
  const sections = diff.split(/(?=^diff --git )/m);
  const out = [];
  for (const sec of sections) {
    if (!sec.trim()) continue;
    const line = sec.split('\n', 1)[0];
    const paths = diffSectionPaths(line);
    if (paths.some(isLockFile)) {
      out.push(`${line}\n(lock file — content omitted)\n`);
    } else if (paths.some((p) => matchStripPattern(p, stripGlobs))) {
      out.push(`${line}\n(generated file — content omitted)\n`);
    } else {
      out.push(sec);
    }
  }
  return out.join('');
}

// Cap a single file's diff section at maxChars, cutting at a line boundary
// and marking the cut. One huge section (e.g. a new generated asset) keeps
// only its header and leading hunks instead of eating the whole prompt
// budget and pushing every other file out.
function capSection(sec, maxChars) {
  if (sec.length <= maxChars) return sec;
  const nl = sec.lastIndexOf('\n', maxChars);
  return sec.slice(0, nl > 0 ? nl : maxChars)
    + `\n... (file section truncated — ${sec.length} chars total)\n`;
}

// Cap a diff: first truncate any single file section beyond maxSectionChars,
// then — if the result still exceeds maxChars — keep complete per-file
// sections until the budget is reached (never cutting mid-hunk) and prepend
// a --stat summary when provided. `truncated` tells callers whether any cut
// happened.
export function condenseDiff(diff, maxChars, stat, maxSectionChars = Infinity) {
  if (Number.isFinite(maxSectionChars) && maxSectionChars > 0) {
    const sections = diff.split(/(?=^diff --git )/m);
    let capped = '';
    let sectionCut = false;
    for (const sec of sections) {
      if (!sec.trim()) continue;
      if (sec.length > maxSectionChars) sectionCut = true;
      capped += capSection(sec, maxSectionChars);
    }
    if (sectionCut) {
      if (capped.length <= maxChars) return { diff: capped, truncated: true };
      diff = capped; // still over budget — run the per-file pass on capped sections
    }
  }

  if (diff.length <= maxChars) return { diff, truncated: false };
  const sections = diff.split(/(?=^diff --git )/m);
  let kept = '';
  for (const sec of sections) {
    if (!sec.trim()) continue;
    if (kept.length + sec.length > maxChars) break;
    kept += sec;
  }
  const marker = `... (diff truncated — ${diff.length} chars total)`;
  const body = kept ? `${kept}\n${marker}` : marker;
  return { diff: stat ? `${stat}\n\n${body}` : body, truncated: true };
}

export function getChangedFiles(cwd) {
  return parseNameStatusZ(readGit(['diff', '--name-status', '-z', '--staged'], cwd))
    .map(({ status, path }) => ({ status, path }));
}

// Working-tree changes vs. the index (git diff without --staged) — same shape
// as getChangedFiles. git diff --staged returns empty for these, so the "no
// staged changes" path uses this to surface them instead of telling the user
// there's nothing to commit when git status clearly shows work. `addPaths`
// carries the real path(s) for `git add` — `path` stays a display string
// ("old → new" for renames), which git cannot add directly.
export function getUnstagedFiles(cwd) {
  return parseNameStatusZ(readGit(['diff', '--name-status', '-z'], cwd));
}

export function getDiffStats(diff) {
  if (!diff) return { files: 0, additions: 0, deletions: 0 };
  const lines = diff.split('\n');
  let files = 0, additions = 0, deletions = 0;
  for (const line of lines) {
    if      (line.startsWith('diff --git'))           files++;
    else if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { files, additions, deletions };
}

// Untracked files (respecting .gitignore) — they never show up in git diff,
// so the "no changes" path uses this to point the user at them.
export function getUntrackedFiles(cwd) {
  const out = readGit(['ls-files', '-z', '--others', '--exclude-standard'], cwd);
  const paths = out.split('\0');
  if (paths.at(-1) === '') paths.pop();
  return paths;
}

export function getBranch(cwd) {
  return readGit(['branch', '--show-current'], cwd).trim();
}

// Keep the explicit repo check so the CLI can give a targeted error before it
// starts reading diffs.
export function isGitRepo(cwd) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd, stdio: ['pipe', 'pipe', 'ignore'],
    });
    return true;
  } catch { return false; }
}

export function gitCommit(message, projectRoot) {
  try {
    // Pass the message as an argv item instead of a shell string — quoting it
    // for a shell breaks on Windows, where cmd.exe ignores single quotes.
    execFileSync('git', ['commit', '-m', message], { cwd: projectRoot, stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

export function runGit(args, projectRoot, inherit = false) {
  execFileSync('git', args, { cwd: projectRoot, stdio: inherit ? 'inherit' : 'pipe' });
}

export function hasHead(projectRoot) {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: projectRoot, stdio: ['pipe', 'pipe', 'ignore'],
    });
    return true;
  } catch { return false; }
}
