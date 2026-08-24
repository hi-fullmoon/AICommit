import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadConfig } from './config.js';
import {
  applyCommitlintPolicy,
  DEFAULT_REPOSITORY_CONTEXT,
  detectCommitlintConstraints,
} from './context.js';
import { ERROR_CATEGORIES, fail } from './errors.js';
import { readGit } from './git.js';
import { normalizeCommitPolicy, validateCommitCandidate } from './policy.js';
import { renderTeamPolicyTemplate } from './team-policy.js';

const MAX_MESSAGE_FILE_BYTES = 1024 * 1024;
const MAX_RANGE_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_RANGE_COMMITS = 1000;

function normalizedPolicyDocument(policy) {
  return {
    version: policy.version,
    types: [...policy.types],
    scope: { mode: policy.scope.mode, values: [...policy.scope.values] },
    subject: { maxLength: policy.subject.maxLength },
    body: { mode: policy.body.mode, maxLines: policy.body.maxLines },
    breakingChange: policy.breakingChange,
    language: policy.language,
    effectiveLanguage: policy.effectiveLanguage,
  };
}

function policyFingerprint(policy) {
  return createHash('sha256')
    .update(JSON.stringify(normalizedPolicyDocument(policy)))
    .digest('hex');
}

async function messageFromFile(path) {
  const absolutePath = resolve(path);
  let info;
  try {
    info = await lstat(absolutePath);
  } catch (err) {
    throw fail(ERROR_CATEGORIES.CONFIG, `Cannot read policy message file: ${path}`, { cause: err });
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw fail(ERROR_CATEGORIES.CONFIG, `Policy message file must be a regular file: ${path}`);
  }
  if (info.size > MAX_MESSAGE_FILE_BYTES) {
    throw fail(ERROR_CATEGORIES.CONFIG, `Policy message file exceeds 1 MiB: ${path}`);
  }
  try {
    return [{ id: 'message-file', message: await readFile(absolutePath, 'utf8') }];
  } catch (err) {
    throw fail(ERROR_CATEGORIES.CONFIG, `Cannot read policy message file: ${path}`, { cause: err });
  }
}

function messagesFromRange(projectRoot, range) {
  if (
    typeof range !== 'string' ||
    !range ||
    range.length > 512 ||
    range.startsWith('-') ||
    /[\0\r\n]/.test(range)
  ) {
    throw fail(ERROR_CATEGORIES.CONFIG, 'Policy Git range is invalid.');
  }
  const output = readGit(
    ['log', '-z', '--format=%H%x00%B', range, '--'],
    projectRoot,
    MAX_RANGE_OUTPUT_BYTES,
  );
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 2 !== 0) {
    throw fail(ERROR_CATEGORIES.GIT_STATE, 'Git returned a malformed commit-message stream.');
  }
  const messages = [];
  for (let index = 0; index < fields.length; index += 2) {
    messages.push({ id: fields[index], message: fields[index + 1] });
  }
  if (!messages.length) {
    throw fail(ERROR_CATEGORIES.GIT_STATE, `Git range contains no commits: ${range}`);
  }
  if (messages.length > MAX_RANGE_COMMITS) {
    throw fail(
      ERROR_CATEGORIES.CONFIG,
      `Policy check is limited to ${MAX_RANGE_COMMITS} commits per run.`,
    );
  }
  return messages;
}

function resultFor(entry, policy) {
  // Team checks treat the resolved repository language as an explicit rule,
  // even when the document says "inherit" inside commitPolicy.
  const validation = validateCommitCandidate(entry.message, {
    policy: { ...policy, language: policy.effectiveLanguage },
  });
  return {
    id: entry.id,
    valid: validation.valid,
    issues: validation.issues.map(({ code, message, severity }) => ({ code, message, severity })),
  };
}

function printResults(data) {
  console.log(`Policy: commitPolicy v${data.policy.version} (${data.policyFingerprint})`);
  for (const result of data.results) {
    console.log(`${result.valid ? '✓' : '✗'} ${result.id}`);
    for (const issue of result.issues) {
      console.log(`  ${issue.severity}: ${issue.code}: ${issue.message}`);
    }
  }
  console.log(
    data.valid
      ? `Policy valid for ${data.results.length} commit message(s).`
      : `Policy violations found in ${data.invalidCount} commit message(s).`,
  );
}

export async function runPolicyCommand(
  action,
  { messageFile = null, range = null, machineOutput = false } = {},
) {
  if (action === 'template') {
    process.stdout.write(renderTeamPolicyTemplate());
    return { exitReason: 'policy_template' };
  }

  const loaded = await loadConfig(null, { resolveCredentials: false });
  const constraints = detectCommitlintConstraints(
    loaded.projectRoot,
    DEFAULT_REPOSITORY_CONTEXT.commitlint,
  );
  const effective = applyCommitlintPolicy(
    loaded.config.commitPolicy,
    constraints,
    loaded.config.language,
  );
  const policy = normalizeCommitPolicy(effective, loaded.config.language);
  const entries = messageFile
    ? await messageFromFile(messageFile)
    : messagesFromRange(loaded.projectRoot, range || 'HEAD');
  const results = entries.map((entry) => resultFor(entry, policy));
  const invalidCount = results.filter((result) => !result.valid).length;
  const machineResults = results.map((result) => ({
    id: result.id,
    valid: result.valid,
    issues: result.issues.map(({ code, severity }) => ({ code, severity })),
  }));
  const data = {
    valid: invalidCount === 0,
    invalidCount,
    policy: normalizedPolicyDocument(policy),
    policyFingerprint: policyFingerprint(policy),
    source: messageFile ? 'file' : 'git-range',
    range: messageFile ? null : range || 'HEAD',
    commitlintSource: constraints?.path || null,
    results: machineResults,
  };
  if (!machineOutput) printResults({ ...data, results });
  if (invalidCount) {
    throw fail(ERROR_CATEGORIES.CONFIG, `Team policy rejected ${invalidCount} commit message(s).`, {
      reported: !machineOutput,
      data,
    });
  }
  return { exitReason: 'policy_valid', data };
}
