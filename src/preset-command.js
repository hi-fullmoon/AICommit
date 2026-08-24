import { homedir } from 'node:os';

import { ERROR_CATEGORIES, fail } from './errors.js';
import {
  installProviderPresetManifest,
  loadProviderPresetManifest,
  providerPresetPaths,
  rollbackProviderPresetManifest,
} from './provider-presets.js';
import { fileExists } from './utils.js';

export async function inspectProviderPresetPaths(home = homedir()) {
  const paths = providerPresetPaths(home);
  return {
    bundled: { path: paths.bundled, exists: await fileExists(paths.bundled) },
    user: { path: paths.user, exists: await fileExists(paths.user) },
    backup: { path: paths.backup, exists: await fileExists(paths.backup) },
  };
}

function printPaths(paths) {
  for (const [name, entry] of Object.entries(paths)) {
    console.log(`${name.padEnd(7)} ${entry.path}${entry.exists ? '' : ' (not found)'}`);
  }
}

export async function runPresetCommand(
  action,
  { file = null, machineOutput = false, home = homedir() } = {},
) {
  const paths = await inspectProviderPresetPaths(home);
  if (action === 'path') {
    if (!machineOutput) printPaths(paths);
    return { exitReason: 'preset_path', data: { paths } };
  }

  try {
    if (action === 'install') {
      const installed = await installProviderPresetManifest(file, { home });
      if (!machineOutput) {
        console.log(`Installed provider preset v${installed.manifest.version}: ${installed.path}`);
      }
      return {
        exitReason: 'preset_installed',
        data: {
          version: installed.manifest.version,
          path: installed.path,
          backupPath: installed.backupPath,
          invalidBackupPath: installed.invalidBackupPath,
        },
      };
    }
    if (action === 'rollback') {
      const installed = await rollbackProviderPresetManifest({ home });
      if (!machineOutput) {
        console.log(`Rolled back to provider preset v${installed.manifest.version}.`);
      }
      return {
        exitReason: 'preset_rolled_back',
        data: {
          version: installed.manifest.version,
          path: installed.path,
          backupPath: installed.backupPath,
          invalidBackupPath: installed.invalidBackupPath,
        },
      };
    }

    const loaded = await loadProviderPresetManifest({ path: file, home });
    const data = {
      valid: true,
      source: loaded.source,
      path: loaded.path,
      version: loaded.manifest.version,
      compatibility: loaded.manifest.compatibility,
      providerCount: loaded.manifest.providers.length,
      ...(action === 'show' ? { manifest: loaded.manifest } : {}),
    };
    if (!machineOutput) {
      if (action === 'show') console.log(JSON.stringify(data, null, 2));
      else {
        console.log(
          `Provider preset v${data.version} is compatible (${data.providerCount} providers, ${data.source}).`,
        );
      }
    }
    return { exitReason: action === 'show' ? 'preset_show' : 'preset_valid', data };
  } catch (err) {
    throw fail(ERROR_CATEGORIES.CONFIG, err.message, { cause: err });
  }
}
