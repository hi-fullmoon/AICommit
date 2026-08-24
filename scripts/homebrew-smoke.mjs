import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { prepareReleaseAssets } from './release-assets.mjs';

if (process.env.AICOMMIT_HOMEBREW_SMOKE !== '1') {
  throw new Error('Refusing to modify Homebrew state without AICOMMIT_HOMEBREW_SMOKE=1.');
}

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

const root = mkdtempSync(join(tmpdir(), 'aicommit-homebrew-smoke-'));
let installed = false;
try {
  const pack = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', root]));
  const tarball = join(root, pack[0].filename);
  const assets = await prepareReleaseAssets({
    tarballPath: tarball,
    outputDirectory: root,
    formulaUrl: pathToFileURL(tarball).href,
    formulaName: 'aicommit-smoke.rb',
    formulaClass: 'AicommitSmoke',
  });
  run('ruby', ['-c', assets.formulaPath]);
  run('brew', ['install', '--formula', assets.formulaPath], {
    env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' },
  });
  installed = true;
  const prefix = run('brew', ['--prefix']).trim();
  const cli = join(prefix, 'bin', 'aicommit');
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  assert.equal(run(cli, ['--version']).trim(), `aicommit v${manifest.version}`);
  assert.match(run(cli, ['--help']), /Usage:/);
  const config = JSON.parse(
    run(cli, ['config', 'validate', '--output=json'], {
      cwd: root,
      env: { ...process.env, HOME: root, USERPROFILE: root, NO_COLOR: '1' },
    }),
  );
  assert.equal(config.exitReason, 'config_valid');
  console.log(`Homebrew smoke passed: aicommit v${manifest.version}`);
} finally {
  if (installed) {
    try {
      run('brew', ['uninstall', '--force', 'aicommit-smoke'], {
        env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' },
      });
    } catch {}
  }
  rmSync(root, { recursive: true, force: true });
}
