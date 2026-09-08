import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const active = new Set();
export function cleanupGitSpools() {
  for (const source of active) source.dispose();
}
process.once('exit', cleanupGitSpools);

// Git writes directly to a private temporary file, never to a Node stdout
// buffer. Consumers scan the captured bytes without reopening the worktree.
export function spoolGit(commands, cwd) {
  const dir = mkdtempSync(join(tmpdir(), 'aicommit-diff-'));
  const path = join(dir, 'patch');
  let fd;
  try {
    fd = openSync(path, 'wx+', 0o600);
    for (const args of commands) {
      execFileSync('git', ['--no-pager', ...args], {
        cwd,
        stdio: ['ignore', fd, 'pipe'],
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      });
    }
    let size = fstatSync(fd).size;
    closeSync(fd);
    fd = undefined;
    const source = {
      get size() {
        return size;
      },
      append(buffer) {
        const output = openSync(path, 'r+');
        try {
          let written = 0;
          while (written < buffer.length)
            written += writeSync(output, buffer, written, buffer.length - written, size + written);
          size += written;
        } finally {
          closeSync(output);
        }
      },
      *buffers() {
        const input = openSync(path, 'r');
        const buffer = Buffer.alloc(64 * 1024);
        let offset = 0;
        try {
          while (offset < size) {
            const count = readSync(input, buffer, 0, buffer.length, offset);
            if (!count) throw new Error('Captured Git patch was truncated.');
            offset += count;
            yield buffer.subarray(0, count);
          }
        } finally {
          closeSync(input);
        }
      },
      *lines(maxLineBytes = 1024 * 1024) {
        let pending = Buffer.alloc(0);
        for (const buffer of this.buffers()) {
          const data = Buffer.concat([pending, buffer]);
          let start = 0;
          for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
            if (end - start > maxLineBytes)
              throw new Error(
                'Diff line exceeds the safe analysis limit (1 MiB); split the change before retrying.',
              );
            yield data.subarray(start, end + 1).toString('utf8');
            start = end + 1;
          }
          pending = Buffer.from(data.subarray(start));
          if (pending.length > maxLineBytes)
            throw new Error(
              'Diff line exceeds the safe analysis limit (1 MiB); split the change before retrying.',
            );
        }
        if (pending.length) yield pending.toString('utf8');
      },
      text(limit) {
        if (size > limit) return null;
        return [...this.lines()].join('').trim();
      },
      dispose() {
        if (!active.delete(source)) return;
        rmSync(dir, { recursive: true, force: true });
      },
    };
    active.add(source);
    return source;
  } catch (err) {
    if (fd !== undefined) closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Failed to capture Git patch: ${err.message}`, { cause: err });
  }
}

export function updateGitHash(hash, args, cwd) {
  const source = spoolGit([args], cwd);
  try {
    for (const buffer of source.buffers()) hash.update(buffer);
  } finally {
    source.dispose();
  }
  return hash;
}
