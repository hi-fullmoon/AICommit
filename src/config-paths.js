import { homedir } from 'node:os';
import { join } from 'node:path';

import { fileExists } from './utils.js';

export const AICOMMIT_DIRECTORY = '.aicommit';
export const CONFIG_FILENAME = 'config.json';
export const PROJECT_CONFIG_FILENAME = '.aicommit.config.json';

export function userConfigLocations(home = homedir()) {
  return {
    canonical: join(home, AICOMMIT_DIRECTORY, CONFIG_FILENAME),
    legacy: join(home, PROJECT_CONFIG_FILENAME),
  };
}

export function projectConfigPath(projectRoot) {
  return join(projectRoot, PROJECT_CONFIG_FILENAME);
}

export async function resolveConfigLocations(locations) {
  const canonicalExists = await fileExists(locations.canonical);
  const legacyExists = await fileExists(locations.legacy);
  return {
    ...locations,
    canonicalExists,
    legacyExists,
    activePath: canonicalExists ? locations.canonical : legacyExists ? locations.legacy : null,
    usingLegacy: !canonicalExists && legacyExists,
  };
}
