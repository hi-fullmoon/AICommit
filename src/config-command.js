import { homedir } from 'node:os';
import { join } from 'node:path';

import { getProjectRoot, loadConfig } from './config.js';
import { fileExists, stringifyConfigRedacted } from './utils.js';
import { TEAM_POLICY_FILENAME } from './team-policy.js';
import { projectConfigPath, resolveConfigLocations, userConfigLocations } from './config-paths.js';

function redactedObject(value) {
  return JSON.parse(stringifyConfigRedacted(value));
}

export async function inspectConfigPaths(projectRoot = getProjectRoot()) {
  const userLocations = await resolveConfigLocations(userConfigLocations(homedir()));
  const project = projectConfigPath(projectRoot);
  const projectExists = project !== userLocations.activePath && (await fileExists(project));
  const teamPolicy = join(projectRoot, TEAM_POLICY_FILENAME);
  return {
    user: {
      path: userLocations.canonical,
      exists: Boolean(userLocations.activePath),
      activePath: userLocations.activePath,
      legacyPath: userLocations.legacy,
      legacyExists: userLocations.legacyExists,
      usingLegacy: userLocations.usingLegacy,
    },
    project: {
      path: project,
      exists: projectExists,
      activePath: projectExists ? project : null,
    },
    teamPolicy: { path: teamPolicy, exists: await fileExists(teamPolicy) },
  };
}

function printPaths(paths) {
  const displayConfigPath = (item) => {
    if (!item.exists) return `${item.path} (not found)`;
    if (item.usingLegacy) return `${item.activePath} (legacy; move to ${item.path})`;
    return item.path;
  };
  console.log(`User config:    ${displayConfigPath(paths.user)}`);
  console.log(`Project config: ${displayConfigPath(paths.project)}`);
  console.log(
    `Team policy:    ${paths.teamPolicy.path}${paths.teamPolicy.exists ? '' : ' (not found)'}`,
  );
}

export async function runConfigCommand(
  action,
  { provider = null, model = null, machineOutput = false } = {},
) {
  const projectRoot = getProjectRoot();
  const paths = await inspectConfigPaths(projectRoot);
  if (action === 'path') {
    if (!machineOutput) printPaths(paths);
    return { exitReason: 'config_path', data: { projectRoot, paths } };
  }

  const loaded = await loadConfig(provider, { model, resolveCredentials: false });
  const data = {
    projectRoot: loaded.projectRoot,
    sources: loaded.loaded,
    provider: loaded.providerName,
    model: loaded.modelName,
    paths,
  };
  if (action === 'validate') {
    if (!machineOutput) {
      console.log(`Configuration valid for ${loaded.providerName}/${loaded.modelName}.`);
      printPaths(paths);
    }
    return { exitReason: 'config_valid', data };
  }

  data.config = redactedObject(loaded.config);
  if (!machineOutput) console.log(JSON.stringify(data, null, 2));
  return { exitReason: 'config_show', data };
}
