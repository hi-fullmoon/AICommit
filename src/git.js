import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

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
    const detail =
      typeof err.stderr === 'string' ? err.stderr.trim() : err.stderr?.toString('utf-8').trim();
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
    if (first === undefined)
      throw new Error('Unexpected truncated output from git --name-status -z.');
    if (status.startsWith('R') || status.startsWith('C')) {
      const second = fields[i++];
      if (second === undefined)
        throw new Error('Unexpected truncated rename output from git --name-status -z.');
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

// Hash the complete staged patch (including binary changes and full object
// ids) so a long-running AI/review step cannot silently commit a different
// index from the one used to generate the message.
export function getIndexFingerprint(cwd) {
  const patch = readGit(['diff', '--staged', '--binary', '--full-index', '--no-ext-diff'], cwd);
  return createHash('sha256').update(patch).digest('hex');
}

function hashFileOrMissing(path) {
  if (!existsSync(path)) return '<missing>';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Save and, unless explicitly released, restore the exact Git index around
// tool-owned staging. The exit hook also covers Ctrl+C and existing
// process.exit paths. Restoration is skipped if another process changed the
// index after our last known mutation, avoiding clobbering concurrent work.
export function createIndexTransaction(projectRoot) {
  const rawIndexPath = readGit(['rev-parse', '--git-path', 'index'], projectRoot).trim();
  const indexPath = isAbsolute(rawIndexPath) ? rawIndexPath : resolve(projectRoot, rawIndexPath);
  const tempDir = mkdtempSync(join(tmpdir(), 'aicommit-index-'));
  const backupPath = join(tempDir, 'index');
  const existed = existsSync(indexPath);
  if (existed) copyFileSync(indexPath, backupPath);

  let active = true;
  let ownedHash = hashFileOrMissing(indexPath);

  const cleanup = () => {
    rmSync(tempDir, { recursive: true, force: true });
  };
  const release = () => {
    if (!active) return;
    active = false;
    process.removeListener('exit', onExit);
    cleanup();
  };
  const restore = ({ force = false } = {}) => {
    if (!active) return true;
    if (!force && hashFileOrMissing(indexPath) !== ownedHash) {
      release();
      return false;
    }
    try {
      if (existed) {
        mkdirSync(dirname(indexPath), { recursive: true });
        copyFileSync(backupPath, indexPath);
      } else {
        rmSync(indexPath, { force: true });
      }
      return true;
    } finally {
      release();
    }
  };
  const onExit = () => {
    try {
      if (!restore()) {
        process.stderr.write(
          '\n  ⚠ Git index changed outside aicommit; it was left untouched instead of restoring the snapshot.\n',
        );
      }
    } catch (err) {
      process.stderr.write(`\n  ⚠ Failed to restore the Git index snapshot: ${err.message}\n`);
    }
  };

  process.once('exit', onExit);
  return {
    markOwned() {
      ownedHash = hashFileOrMissing(indexPath);
    },
    restore,
    release,
  };
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
const LOCK_FILE_RE =
  /^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock|bun\.lockb|gemfile\.lock|go\.sum|cargo\.lock|composer\.lock|poetry\.lock|pipfile\.lock|uv\.lock|deno\.lock|gradle\.lockfile|.*\.terraform\.lock\.hcl)$/i;

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
      '^' +
        glob
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.') +
        '$',
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
  return parts.map((p) => p.replace(/^"|"$/g, '').replace(/^[ab]\//, ''));
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
  return (
    sec.slice(0, nl > 0 ? nl : maxChars) +
    `\n... (file section truncated — ${sec.length} chars total)\n`
  );
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
  return parseNameStatusZ(readGit(['diff', '--name-status', '-z', '--staged'], cwd)).map(
    ({ status, path }) => ({ status, path }),
  );
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
  let files = 0,
    additions = 0,
    deletions = 0;
  for (const line of lines) {
    if (line.startsWith('diff --git')) files++;
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
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function gitCommit(message, projectRoot, diagnosticsOnly = false) {
  // Pass the message as an argv item instead of a shell string — quoting it
  // for a shell breaks on Windows, where cmd.exe ignores single quotes.
  // Do not swallow failures: the CLI must return a non-zero exit status when
  // Git or a commit hook rejects the commit.
  execFileSync('git', ['commit', '-m', message], {
    cwd: projectRoot,
    stdio: diagnosticsOnly ? [process.stdin, process.stderr, process.stderr] : 'inherit',
  });
  return true;
}

const SENSITIVE_FILE_RE =
  /(?:^|\/)(?:\.env(?:\..+)?|\.aicommit\.config\.json|\.aicommit\/config\.json|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials?(?:\.[^/]*)?|service[-_]?account(?:\.[^/]*)?|[^/]+\.(?:pem|p12|pfx|key|keystore))$/i;
const PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i;
const AWS_KEY_RE = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const ASSIGNED_SECRET_RE =
  /(\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|password|passwd|secret|token)\b\s*[:=]\s*["']?)([^\s,"'}]{8,})/gi;

export function isSensitiveFile(path) {
  const normalized = String(path || '').replace(/\\/g, '/');
  if (/\.env\.(?:example|sample|template)$/i.test(normalized)) return false;
  return SENSITIVE_FILE_RE.test(normalized);
}

// Protect standalone text such as an untracked-file preview. Unlike a Git
// diff, these lines have no +/- prefix, so they need their own scanner before
// split planning can safely include them in a model request.
export function protectSensitiveText(text, path = '(unknown file)') {
  const source = String(text || '');
  if (isSensitiveFile(path)) {
    return { text: '', findings: [`sensitive file: ${path}`] };
  }
  if (PRIVATE_KEY_RE.test(source)) {
    return { text: '', findings: [`private-key material in: ${path}`] };
  }

  let foundAssignedSecret = false;
  let foundCloudKey = false;
  let protectedText = source.replace(AWS_KEY_RE, () => {
    foundCloudKey = true;
    return '[REDACTED_ACCESS_KEY]';
  });
  protectedText = protectedText.replace(ASSIGNED_SECRET_RE, (_match, prefix) => {
    foundAssignedSecret = true;
    return `${prefix}[REDACTED]`;
  });

  const findings = [];
  if (foundAssignedSecret) findings.push(`credential-like assignment in: ${path}`);
  if (foundCloudKey) findings.push(`cloud access key in: ${path}`);
  return { text: protectedText, findings };
}

// Build a safer model input without changing what Git will commit. Entire
// sensitive/private-key sections are omitted; common credential assignments
// and cloud access-key ids in ordinary source diffs are redacted. This is a
// warning layer, not a substitute for repository secret scanning.
export function protectSensitiveDiff(diff) {
  const sections = String(diff || '').split(/(?=^diff --git )/m);
  const out = [];
  const findings = [];

  for (const sec of sections) {
    if (!sec.trim()) continue;
    const line = sec.split('\n', 1)[0];
    const paths = diffSectionPaths(line);
    const sensitivePath = paths.find(isSensitiveFile);
    if (sensitivePath) {
      findings.push(`sensitive file: ${sensitivePath}`);
      out.push(`${line}\n(sensitive file — content omitted)\n`);
      continue;
    }
    if (PRIVATE_KEY_RE.test(sec)) {
      findings.push(`private-key material in: ${paths.at(-1) || '(unknown file)'}`);
      out.push(`${line}\n(private key material — content omitted)\n`);
      continue;
    }

    let foundAssignedSecret = false;
    let foundCloudKey = false;
    const redacted = sec
      .split('\n')
      .map((diffLine) => {
        // Inspect both added and deleted content: removed credentials are absent
        // from the new snapshot but are still present in the outbound diff.
        const contentLine = diffLine.startsWith('+') || diffLine.startsWith('-');
        if (!contentLine || diffLine.startsWith('+++') || diffLine.startsWith('---'))
          return diffLine;
        let next = diffLine.replace(AWS_KEY_RE, () => {
          foundCloudKey = true;
          return '[REDACTED_ACCESS_KEY]';
        });
        next = next.replace(ASSIGNED_SECRET_RE, (_m, prefix) => {
          foundAssignedSecret = true;
          return `${prefix}[REDACTED]`;
        });
        return next;
      })
      .join('\n');
    const displayPath = paths.at(-1) || '(unknown file)';
    if (foundAssignedSecret) findings.push(`credential-like assignment in: ${displayPath}`);
    if (foundCloudKey) findings.push(`cloud access key in: ${displayPath}`);
    out.push(redacted);
  }

  return { diff: out.join(''), findings: [...new Set(findings)] };
}

export function runGit(args, projectRoot, inherit = false) {
  try {
    const stdio =
      inherit === 'stderr'
        ? [process.stdin, process.stderr, process.stderr]
        : inherit
          ? 'inherit'
          : 'pipe';
    execFileSync('git', args, { cwd: projectRoot, stdio });
  } catch (err) {
    const detail =
      typeof err.stderr === 'string' ? err.stderr.trim() : err.stderr?.toString('utf-8').trim();
    const suffix = detail ? `: ${detail}` : '';
    throw new Error(`git ${args.join(' ')} failed${suffix}`, { cause: err });
  }
}

export function hasHead(projectRoot) {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}
