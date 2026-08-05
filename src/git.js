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
