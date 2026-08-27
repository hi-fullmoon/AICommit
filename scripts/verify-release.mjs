import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
const tag = process.env.GITHUB_REF_NAME || process.argv[2];

assert.match(manifest.name, /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/);
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.notEqual(manifest.private, true, 'package.json must not be private');
assert.equal(manifest.publishConfig?.access, 'public', 'publishConfig.access must be public');
assert.equal(manifest.publishConfig?.provenance, true, 'publishConfig.provenance must be enabled');
assert.ok(manifest.bin?.aicommit, 'package.json must expose the aicommit executable');
assert.match(
  manifest.repository?.url || '',
  /^git\+https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/,
  'repository.url must be the canonical GitHub HTTPS URL required by npm Trusted Publishing',
);

if (tag) {
  assert.equal(tag, `v${manifest.version}`, `release tag ${tag} must match v${manifest.version}`);
  console.log(`Release tag verified: ${tag}`);
} else {
  console.log(`Release manifest verified: ${manifest.name}@${manifest.version}`);
}
