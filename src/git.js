import { execSync, execFileSync } from 'node:child_process';

export function getStagedDiff() {
  let diff;
  try {
    diff = execSync('git diff --staged', {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch { diff = ''; }

  const isStaged = diff.trim().length > 0;

  if (!isStaged) {
    try {
      diff = execSync('git diff', {
        encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch { diff = ''; }
  }

  return { diff: diff.trim(), isStaged };
}

// Compact one-line-per-file summary of the same changes getStagedDiff returns.
// Used to prepend context when a diff is condensed, so the model still sees
// the full change scope without paying for every hunk.
export function getDiffStat(isStaged) {
  const flag = isStaged ? '--staged' : '';
  try {
    return execSync(`git diff --stat ${flag}`, {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch { return ''; }
}

// Lock files only record resolved dependency versions — their content carries
// no commit intent, and a package-lock.json bump can be tens of thousands of
// lines. Matching by basename (case-insensitive) covers them at any depth.
const LOCK_FILE_RE = /^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock|bun\.lockb|gemfile\.lock|go\.sum|cargo\.lock|composer\.lock|poetry\.lock|pipfile\.lock|uv\.lock|deno\.lock|gradle\.lockfile|.*\.terraform\.lock\.hcl)$/i;

export function isLockFile(path) {
  const base = (path || '').split('/').pop() || path;
  return LOCK_FILE_RE.test(base);
}

// Paths on a "diff --git a/x b/y" header line, unquoted and without the a/ b/
// prefix. Handles git's C-style quoting of paths that contain spaces.
function diffSectionPaths(line) {
  const rest = line.replace(/^diff --git\s+/, '');
  const parts = rest.match(/(?:"[^"]*"|\S+)/g) || [];
  return parts.map(p => p.replace(/^"|"$/g, '').replace(/^[ab]\//, ''));
}

// Replace the body of every lock-file section in a raw git diff with a short
// stub, keeping only the "diff --git" header so the model still sees that the
// file changed. git diff sections begin at lines starting with "diff --git".
export function stripLockFileContent(diff) {
  const sections = diff.split(/(?=^diff --git )/m);
  const out = [];
  for (const sec of sections) {
    if (!sec.trim()) continue;
    const line = sec.split('\n', 1)[0];
    if (diffSectionPaths(line).some(isLockFile)) {
      out.push(`${line}\n(lock file — content omitted)\n`);
    } else {
      out.push(sec);
    }
  }
  return out.join('');
}

// Cap a diff that exceeds maxChars: keep complete per-file sections until the
// budget is reached (never cutting mid-hunk), prepend a --stat summary when
// provided, and mark the cut so callers can tell the user what happened.
export function condenseDiff(diff, maxChars, stat) {
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

export function getChangedFiles(isStaged) {
  const flag = isStaged ? '--staged' : '';
  try {
    const out = execSync(`git diff --name-status ${flag}`, {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    if (!out) return [];
    return out.split('\n').map(line => {
      // Format: "<status>\t<path>" or "<status>\t<old>\t<new>" for renames
      const parts = line.split('\t');
      const status = parts[0];
      const path   = parts.length === 3 ? `${parts[1]} → ${parts[2]}` : parts[1];
      return { status, path };
    });
  } catch { return []; }
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

export function getBranch() {
  try {
    return execSync('git branch --show-current', {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}

export function gitAdd(projectRoot) {
  execSync('git add -A', { cwd: projectRoot, stdio: 'pipe' });
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
