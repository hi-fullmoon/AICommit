import { homedir } from 'node:os';
import { join } from 'node:path';

import { getProjectRoot, loadConfig } from './config.js';
import { fileExists, stringifyConfigRedacted } from './utils.js';

function redactedObject(value) {
  return JSON.parse(stringifyConfigRedacted(value));
}

export async function inspectConfigPaths(projectRoot = getProjectRoot()) {
  const user = join(homedir(), '.aicommit.config.json');
  const project = join(projectRoot, '.aicommit.config.json');
  return {
    user: { path: user, exists: await fileExists(user) },
    project: { path: project, exists: project !== user && (await fileExists(project)) },
  };
}

function printPaths(paths) {
  console.log(`User config:    ${paths.user.path}${paths.user.exists ? '' : ' (not found)'}`);
  console.log(`Project config: ${paths.project.path}${paths.project.exists ? '' : ' (not found)'}`);
}

export async function runConfigCommand(action, { provider = null, machineOutput = false } = {}) {
  const projectRoot = getProjectRoot();
  const paths = await inspectConfigPaths(projectRoot);
  if (action === 'path') {
    if (!machineOutput) printPaths(paths);
    return { exitReason: 'config_path', data: { projectRoot, paths } };
  }

  const loaded = await loadConfig(provider, { resolveCredentials: false });
  const data = {
    projectRoot: loaded.projectRoot,
    sources: loaded.loaded,
    provider: loaded.providerName,
    paths,
  };
  if (action === 'validate') {
    if (!machineOutput) {
      console.log(
        `Configuration valid${loaded.providerName ? ` for provider "${loaded.providerName}"` : ''}.`,
      );
      printPaths(paths);
    }
    return { exitReason: 'config_valid', data };
  }

  data.config = redactedObject(loaded.config);
  if (!machineOutput) console.log(JSON.stringify(data, null, 2));
  return { exitReason: 'config_show', data };
}
