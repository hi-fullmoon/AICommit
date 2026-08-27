import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const tap = `aicommit-smoke-${process.pid}/local`;
const formula = `${tap}/aicommit-smoke`;
let installed = false;
let tapCreated = false;
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
  run('brew', ['tap-new', '--no-git', tap], {
    env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' },
  });
  tapCreated = true;
  const tapRoot = run('brew', ['--repository', tap]).trim();
  copyFileSync(assets.formulaPath, join(tapRoot, 'Formula', 'aicommit-smoke.rb'));
  run('brew', ['install', '--formula', '--skip-link', formula], {
    env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' },
  });
  installed = true;
  const prefix = run('brew', ['--prefix', formula]).trim();
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
      run('brew', ['uninstall', '--force', formula], {
        env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' },
      });
    } catch {}
  }
  if (tapCreated) {
    try {
      run('brew', ['untap', '--force', tap], {
        env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' },
      });
    } catch {}
  }
  rmSync(root, { recursive: true, force: true });
}
