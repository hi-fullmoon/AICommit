import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getDiffStats } from '../src/git.js';

test('getDiffStats counts files and +/- lines, ignoring headers', () => {
  const diff = [
    'diff --git a/a.txt b/a.txt',
    'index 123..456 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,2 +1,2 @@',
    '-old line',
    '+new line',
    ' context',
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1 @@',
    '+brand new',
  ].join('\n');

  assert.deepEqual(getDiffStats(diff), { files: 2, additions: 2, deletions: 1 });
});

test('getDiffStats returns zeros for empty input', () => {
  assert.deepEqual(getDiffStats(''), { files: 0, additions: 0, deletions: 0 });
  assert.deepEqual(getDiffStats(null), { files: 0, additions: 0, deletions: 0 });
});
