import { execFileSync } from 'node:child_process';

export function isLoopbackEndpoint(apiUrl) {
  try {
    const { hostname, protocol } = new URL(apiUrl);
    const loopback =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('127.') ||
      hostname === '[::1]';
    return loopback && (protocol === 'http:' || protocol === 'https:');
  } catch {
    return false;
  }
}

export function gitCredentialQuery(apiUrl, username = 'aicommit') {
  if (/[\r\n\0]/.test(username)) {
    throw new Error('Credential helper username must not contain control characters.');
  }
  const url = new URL(apiUrl);
  return [
    `protocol=${url.protocol.slice(0, -1)}`,
    `host=${url.host}`,
    `path=${url.pathname.replace(/^\//, '')}`,
    `username=${username}`,
    '',
    '',
  ].join('\n');
}

function parseCredentialOutput(output) {
  const fields = {};
  for (const line of String(output || '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0) fields[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return fields.password || null;
}

export function readGitCredential(apiUrl, username = 'aicommit', run = execFileSync) {
  const output = run('git', ['credential', 'fill'], {
    input: gitCredentialQuery(apiUrl, username),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  return parseCredentialOutput(output);
}

export function resolveCredential(config, options = {}) {
  const env = options.env || process.env;
  const readCredential = options.readCredential || readGitCredential;

  if (config.apiKeyEnv && env[config.apiKeyEnv]) {
    return {
      apiKey: env[config.apiKeyEnv],
      source: 'environment',
      sourceLabel: `env:${config.apiKeyEnv}`,
    };
  }

  let helperError = null;
  if (config.credentialHelper?.enabled) {
    try {
      const apiKey = readCredential(config.apiUrl, config.credentialHelper.username);
      if (apiKey) {
        return {
          apiKey,
          source: 'credential-helper',
          sourceLabel: 'git credential helper',
        };
      }
      helperError = new Error('Git credential helper returned no password.');
    } catch (err) {
      helperError = err;
    }
  }

  if (config.apiKey) {
    return {
      apiKey: config.apiKey,
      source: 'config',
      sourceLabel: 'plaintext user config',
      warning: helperError
        ? `Credential helper unavailable: ${helperError.message}`
        : 'API key is stored as plaintext in the user config.',
    };
  }

  if (isLoopbackEndpoint(config.apiUrl)) {
    return {
      apiKey: '',
      source: 'keyless-local',
      sourceLabel: 'keyless localhost',
      warning: helperError ? `Credential helper unavailable: ${helperError.message}` : null,
    };
  }

  if (config.apiKeyEnv) {
    const suffix = helperError ? ` Credential helper fallback failed: ${helperError.message}` : '';
    throw new Error(
      `Environment variable "${config.apiKeyEnv}" configured by apiKeyEnv is not set.${suffix}`,
    );
  }
  if (helperError) {
    throw new Error(`Credential helper failed for ${config.apiUrl}: ${helperError.message}`);
  }

  return {
    apiKey: '',
    source: 'none',
    sourceLabel: 'no credential configured',
    warning: 'No credential is configured for a remote endpoint.',
  };
}
