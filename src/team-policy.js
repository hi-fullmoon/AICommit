import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { normalizeCommitPolicy, validateCommitPolicyConfig } from './policy.js';
import { fileExists } from './utils.js';

export const TEAM_POLICY_KIND = 'aicommit-team-policy';
export const TEAM_POLICY_VERSION = 1;
export const TEAM_POLICY_FILENAME = '.aicommit.policy.json';
const MAX_TEAM_POLICY_BYTES = 64 * 1024;

export const TEAM_POLICY_TEMPLATE = Object.freeze({
  kind: TEAM_POLICY_KIND,
  version: TEAM_POLICY_VERSION,
  language: 'en',
  commitPolicy: Object.freeze({
    version: 1,
    types: Object.freeze(['feat', 'fix', 'docs', 'refactor', 'test', 'chore']),
    scope: Object.freeze({ mode: 'optional', values: Object.freeze([]) }),
    subject: Object.freeze({ maxLength: 72 }),
    body: Object.freeze({ mode: 'optional', maxLines: 8 }),
    breakingChange: 'allow',
    language: 'inherit',
  }),
});

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, expected, path) {
  if (!object(value)) throw new Error(`${path} must be an object.`);
  const expectedSet = new Set(expected);
  const unknown = Object.keys(value).filter((key) => !expectedSet.has(key));
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length)
    throw new Error(`${path} contains unknown properties: ${unknown.join(', ')}.`);
  if (missing.length)
    throw new Error(`${path} is missing required properties: ${missing.join(', ')}.`);
}

export function validateTeamPolicyDocument(value) {
  assertExactKeys(value, ['kind', 'version', 'language', 'commitPolicy'], 'Team policy');
  if (value.kind !== TEAM_POLICY_KIND) {
    throw new Error(`Team policy kind must be "${TEAM_POLICY_KIND}".`);
  }
  if (value.version !== TEAM_POLICY_VERSION) {
    throw new Error(`Team policy version must be ${TEAM_POLICY_VERSION}.`);
  }
  if (!['zh', 'en'].includes(value.language)) {
    throw new Error('Team policy language must be zh or en.');
  }

  assertExactKeys(
    value.commitPolicy,
    ['version', 'types', 'scope', 'subject', 'body', 'breakingChange', 'language'],
    'Team policy commitPolicy',
  );
  assertExactKeys(value.commitPolicy.scope, ['mode', 'values'], 'Team policy commitPolicy.scope');
  assertExactKeys(value.commitPolicy.subject, ['maxLength'], 'Team policy commitPolicy.subject');
  assertExactKeys(value.commitPolicy.body, ['mode', 'maxLines'], 'Team policy commitPolicy.body');
  validateCommitPolicyConfig(value.commitPolicy);
  return value;
}

export function renderTeamPolicyTemplate() {
  return `${JSON.stringify(TEAM_POLICY_TEMPLATE, null, 2)}\n`;
}

export async function readTeamPolicy(projectRoot) {
  const path = join(projectRoot, TEAM_POLICY_FILENAME);
  if (!(await fileExists(path))) return null;
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Failed to read team policy ${path}: expected a regular non-symlinked file.`);
  }
  if (info.size > MAX_TEAM_POLICY_BYTES) {
    throw new Error(`Failed to read team policy ${path}: file exceeds 64 KiB.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
    validateTeamPolicyDocument(parsed);
  } catch (err) {
    throw new Error(`Failed to parse team policy ${path}: ${err.message}`, { cause: err });
  }
  const normalized = normalizeCommitPolicy(parsed.commitPolicy, parsed.language);
  delete normalized.effectiveLanguage;
  return {
    path,
    language: parsed.language,
    commitPolicy: normalized,
  };
}
