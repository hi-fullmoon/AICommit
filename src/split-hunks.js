import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function git(projectRoot, args, { indexPath = null, input = undefined } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
      env: indexPath ? { ...process.env, GIT_INDEX_FILE: indexPath } : process.env,
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = err.stderr?.toString('utf8').trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`, { cause: err });
  }
}

function updateIndexEntry(projectRoot, indexPath, path, entry) {
  if (entry) {
    git(
      projectRoot,
      ['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.oid},${path}`],
      { indexPath },
    );
  } else {
    git(projectRoot, ['update-index', '--force-remove', '--', path], { indexPath });
  }
}

function parseIndexEntries(text) {
  const entries = new Map();
  for (const field of text.split('\0')) {
    if (!field) continue;
    const match = field.match(/^(\d+) ([0-9a-f]+) 0\t([\s\S]+)$/);
    if (match) entries.set(match[3], { mode: match[1], oid: match[2] });
  }
  return entries;
}

function parsePatch(path, patch) {
  if (
    !patch.startsWith('diff --git ') ||
    /^(?:GIT binary patch|Binary files |new file mode |deleted file mode |old mode |new mode |rename (?:from|to) )/m.test(
      patch,
    )
  ) {
    return null;
  }
  const matches = [...patch.matchAll(/^@@ /gm)];
  if (matches.length < 2) return null;
  const header = patch.slice(0, matches[0].index);
  const hunks = matches.map((match, index) => {
    const end = matches[index + 1]?.index ?? patch.length;
    const text = patch.slice(match.index, end);
    const coordinates = text.match(HUNK_HEADER_RE);
    if (!coordinates) throw new Error(`Cannot parse unified hunk header for ${path}.`);
    return {
      id: `H${index + 1}`,
      hash: createHash('sha256').update(`${path}\0${text}`).digest('hex'),
      oldStart: Number(coordinates[1]),
      oldLines: Number(coordinates[2] ?? 1),
      newStart: Number(coordinates[3]),
      newLines: Number(coordinates[4] ?? 1),
      text,
    };
  });
  return { path, header, hunks };
}

function targetTreeAndPatches(projectRoot, baseHead, changes, snapshots) {
  if (!baseHead) return { targetTree: null, patches: new Map() };
  const snapshot = new Map(snapshots.map((entry) => [entry.path, entry.target]));
  const candidates = changes.filter(
    (change) =>
      change.addPaths.length === 1 &&
      change.status.includes('M') &&
      snapshot.get(change.addPaths[0]),
  );
  const tempDir = mkdtempSync(join(tmpdir(), 'aicommit-split-hunks-'));
  const indexPath = join(tempDir, 'index');
  try {
    git(projectRoot, ['read-tree', baseHead], { indexPath });
    for (const change of candidates) {
      const path = change.addPaths[0];
      updateIndexEntry(projectRoot, indexPath, path, snapshot.get(path));
    }
    const targetTree = git(projectRoot, ['write-tree'], { indexPath }).trim();
    const patches = new Map();
    for (const change of candidates) {
      const path = change.addPaths[0];
      const patch = git(projectRoot, [
        'diff',
        '--no-ext-diff',
        '--binary',
        '--no-textconv',
        '--full-index',
        '--unified=3',
        baseHead,
        targetTree,
        '--',
        path,
      ]);
      const parsed = parsePatch(path, patch);
      if (parsed) patches.set(change.path, parsed);
    }
    return { targetTree, patches };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function publicHunk(hunk) {
  return {
    id: hunk.id,
    hash: hunk.hash,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
  };
}

export function discoverSplitHunks(projectRoot, baseHead, changes, snapshots) {
  const { patches } = targetTreeAndPatches(projectRoot, baseHead, changes, snapshots);
  return changes.map((change) => {
    const parsed = patches.get(change.path);
    return parsed
      ? { ...change, hunks: parsed.hunks.map(publicHunk) }
      : { status: change.status, path: change.path, addPaths: [...change.addPaths] };
  });
}

function sameHunkMetadata(expected, actual) {
  return (
    expected.id === actual.id &&
    expected.hash === actual.hash &&
    expected.oldStart === actual.oldStart &&
    expected.oldLines === actual.oldLines &&
    expected.newStart === actual.newStart &&
    expected.newLines === actual.newLines
  );
}

function validateCatalog(plan, patches) {
  for (const change of plan.changes) {
    if (!change.hunks?.length) continue;
    const parsed = patches.get(change.path);
    if (
      !parsed ||
      parsed.hunks.length !== change.hunks.length ||
      change.hunks.some((hunk, index) => !sameHunkMetadata(hunk, parsed.hunks[index]))
    ) {
      throw new Error(`Hunk catalog no longer matches the target snapshot: ${change.path}`);
    }
  }
}

function groupRealPaths(group, changes) {
  const byPath = new Map(changes.map((change) => [change.path, change]));
  const displays = [...group.files, ...(group.hunks || []).map((entry) => entry.path)];
  return [...new Set(displays.flatMap((path) => byPath.get(path)?.addPaths || [path]))];
}

function entriesEqual(left, right) {
  if (!left) return !right;
  return Boolean(right) && left.mode === right.mode && left.oid === right.oid;
}

export function validateHunkTransaction(projectRoot, plan, snapshots) {
  if (!plan.hunkMode) return null;
  const { patches } = targetTreeAndPatches(projectRoot, plan.baseHead, plan.changes, snapshots);
  validateCatalog(plan, patches);

  const snapshot = new Map(snapshots.map((entry) => [entry.path, entry.target]));
  const byDisplay = new Map(plan.changes.map((change) => [change.path, change]));
  const tempDir = mkdtempSync(join(tmpdir(), 'aicommit-split-hunk-validate-'));
  const indexPath = join(tempDir, 'index');
  const groupTrees = [];
  try {
    git(projectRoot, ['read-tree', plan.baseHead], { indexPath });
    let previousTree = git(projectRoot, ['write-tree'], { indexPath }).trim();
    for (const [groupIndex, group] of plan.groups.entries()) {
      for (const path of group.files) {
        const change = byDisplay.get(path);
        for (const realPath of change.addPaths) {
          updateIndexEntry(projectRoot, indexPath, realPath, snapshot.get(realPath) || null);
        }
      }
      for (const assignment of group.hunks || []) {
        const parsed = patches.get(assignment.path);
        const selected = new Set(assignment.ids);
        const patch =
          parsed.header +
          parsed.hunks
            .filter((hunk) => selected.has(hunk.id))
            .map((hunk) => hunk.text)
            .join('');
        git(projectRoot, ['apply', '--cached', '--3way', '--whitespace=nowarn', '--recount', '-'], {
          indexPath,
          input: patch,
        });
      }
      const tree = git(projectRoot, ['write-tree'], { indexPath }).trim();
      if (tree === previousTree) {
        throw new Error(`Hunk group ${groupIndex + 1} would create an empty commit.`);
      }
      groupTrees.push(tree);
      previousTree = tree;
    }

    const finalEntries = parseIndexEntries(
      git(projectRoot, ['ls-files', '--stage', '-z', '--', ...snapshots.map((item) => item.path)], {
        indexPath,
      }),
    );
    for (const entry of snapshots) {
      if (!entriesEqual(finalEntries.get(entry.path) || null, entry.target)) {
        throw new Error(`Hunk plan is not lossless for ${entry.path}.`);
      }
    }
    return {
      groupTrees,
      realPaths: plan.groups.map((group) => groupRealPaths(group, plan.changes)),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function stripHunkCatalog(changes) {
  return changes.map((change) => ({
    status: change.status,
    path: change.path,
    addPaths: [...change.addPaths],
  }));
}

export function fallbackHunkGroups(groups, changes) {
  const hunkPaths = new Set(
    changes.filter((change) => change.hunks?.length).map((change) => change.path),
  );
  const owner = new Map();
  groups.forEach((group, index) => {
    for (const assignment of group.hunks || []) {
      if (!owner.has(assignment.path)) owner.set(assignment.path, index);
    }
  });
  return groups
    .map((group, index) => {
      const files = [...group.files];
      for (const path of hunkPaths) {
        if (owner.get(path) === index && !files.includes(path)) files.push(path);
      }
      return { message: group.message, files };
    })
    .filter((group) => group.files.length);
}
