import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
const tag = process.env.GITHUB_REF_NAME || process.argv[2];

assert.ok(tag, 'release tag is required through GITHUB_REF_NAME or argv[2]');
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.equal(tag, `v${manifest.version}`, `release tag ${tag} must match v${manifest.version}`);

console.log(`Release tag verified: ${tag}`);
