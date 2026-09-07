import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { getIndexFingerprint } from '../src/git.js';
import { cleanupGitSpools, spoolGit } from '../src/git-spool.js';

// Separate processes keep each RSS measurement independent. No provider calls.
const sizeMiB = Number(process.argv[2]);
if (!sizeMiB) {
  for (const size of [32, 96]) {
    process.stdout.write(
      execFileSync(process.execPath, [fileURLToPath(import.meta.url), String(size)], {
        encoding: 'utf8',
      }),
    );
  }
} else {
  const cwd = mkdtempSync(join(tmpdir(), 'aicommit-scale-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    const fd = openSync(join(cwd, 'fixture.txt'), 'w');
    try {
      const buffer = Buffer.from('generated fixture line\n'.repeat(4096));
      let remaining = sizeMiB * 1024 * 1024;
      while (remaining > 0)
        remaining -= writeSync(fd, buffer, 0, Math.min(buffer.length, remaining));
    } finally {
      closeSync(fd);
    }
    git('add', '-A');
    const start = performance.now();
    const source = spoolGit([['diff', '--staged']], cwd);
    let bytes = 0;
    for (const buffer of source.buffers()) bytes += buffer.length;
    getIndexFingerprint(cwd);
    console.log(
      JSON.stringify({
        fixtureMiB: sizeMiB,
        patchBytes: bytes,
        elapsedMs: Math.round(performance.now() - start),
        peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
        providerRequests: 0,
      }),
    );
  } finally {
    cleanupGitSpools();
    rmSync(cwd, { recursive: true, force: true });
  }
}
