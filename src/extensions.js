import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER_PATH = fileURLToPath(new URL('./extension-runner.mjs', import.meta.url));
const EXTENSION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CAPABILITIES = new Set(['contextProvider', 'messageValidator', 'providerAdapter']);
const MAX_MANIFEST_BYTES = 32_000;
const MAX_RESULT_CHARS = 128_000;
const SECRET_FIELD =
  /^(?:authorization|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret)$/i;

export const EXTENSION_HOST = Symbol.for('aicommit.extensionHost');

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function strictKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown field(s): ${unknown.join(', ')}.`);
}

export function isExtensionProviderType(value) {
  return (
    typeof value === 'string' &&
    value.startsWith('extension:') &&
    EXTENSION_ID.test(value.slice(10))
  );
}

export function validateExtensionsConfig(value) {
  if (!object(value)) throw new Error('Invalid config "extensions": expected an object.');
  strictKeys(value, new Set(['manifests', 'timeoutMs', 'maxContextChars']), 'Config "extensions"');
  if (
    !Array.isArray(value.manifests) ||
    value.manifests.length > 20 ||
    value.manifests.some(
      (path) => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'),
    )
  ) {
    throw new Error(
      'Invalid config "extensions.manifests": expected at most 20 absolute manifest paths.',
    );
  }
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 30_000) {
    throw new Error(
      'Invalid config "extensions.timeoutMs": expected an integer between 100 and 30000.',
    );
  }
  if (
    !Number.isInteger(value.maxContextChars) ||
    value.maxContextChars < 0 ||
    value.maxContextChars > 10_000
  ) {
    throw new Error(
      'Invalid config "extensions.maxContextChars": expected an integer between 0 and 10000.',
    );
  }
  return value;
}

function validateManifest(value, manifestPath) {
  if (!object(value)) throw new Error(`Extension manifest ${manifestPath} must be an object.`);
  strictKeys(
    value,
    new Set(['kind', 'apiVersion', 'id', 'version', 'entry', 'capabilities', 'permissions']),
    `Extension manifest ${manifestPath}`,
  );
  if (value.kind !== 'aicommit-extension') throw new Error(`${manifestPath}: invalid kind.`);
  if (value.apiVersion !== 1) throw new Error(`${manifestPath}: apiVersion must be 1.`);
  if (!EXTENSION_ID.test(value.id || '')) throw new Error(`${manifestPath}: invalid extension id.`);
  if (!SEMVER.test(value.version || '')) throw new Error(`${manifestPath}: invalid version.`);
  if (
    typeof value.entry !== 'string' ||
    !value.entry.endsWith('.mjs') ||
    isAbsolute(value.entry) ||
    value.entry.includes('\0')
  ) {
    throw new Error(`${manifestPath}: entry must be a relative .mjs path.`);
  }
  if (
    !Array.isArray(value.capabilities) ||
    value.capabilities.length === 0 ||
    new Set(value.capabilities).size !== value.capabilities.length ||
    value.capabilities.some((name) => !CAPABILITIES.has(name))
  ) {
    throw new Error(`${manifestPath}: capabilities contain an unsupported or duplicate value.`);
  }
  if (!object(value.permissions))
    throw new Error(`${manifestPath}: permissions must be an object.`);
  strictKeys(value.permissions, new Set(['credentials']), `${manifestPath} permissions`);
  if (value.permissions.credentials !== false) {
    throw new Error(`${manifestPath}: permissions.credentials must be false in extension API v1.`);
  }
  return value;
}

async function loadManifest(manifestPath) {
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error(`Extension manifest must be a regular non-symlink file: ${manifestPath}`);
  }
  if (manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new Error(`Extension manifest exceeds ${MAX_MANIFEST_BYTES} bytes: ${manifestPath}`);
  }
  const canonicalManifest = await realpath(manifestPath);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(canonicalManifest, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse extension manifest ${manifestPath}: ${error.message}`);
  }
  const manifest = validateManifest(parsed, manifestPath);
  const root = dirname(canonicalManifest);
  const candidate = resolve(root, manifest.entry);
  const prefix = `${root}${process.platform === 'win32' ? '\\' : '/'}`;
  if (!candidate.startsWith(prefix))
    throw new Error(`${manifestPath}: entry escapes its directory.`);
  const entryStat = await lstat(candidate);
  if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
    throw new Error(`${manifestPath}: entry must be a regular non-symlink file.`);
  }
  const entry = await realpath(candidate);
  if (!entry.startsWith(prefix)) throw new Error(`${manifestPath}: entry escapes its directory.`);
  return Object.freeze({ ...manifest, manifestPath: canonicalManifest, entry });
}

function permissionArgs(version = process.versions.node) {
  const major = Number(version.split('.')[0]);
  if (major < 20) {
    throw new Error(
      'Executable extensions require Node.js 20 or newer for credential-deny isolation. Core aicommit remains supported on Node.js 18 when extensions are disabled.',
    );
  }
  return [major >= 23 ? '--permission' : '--experimental-permission'];
}

function safeEnvironment() {
  return {
    PATH: process.env.PATH || '',
    LANG: process.env.LANG || 'C',
    LC_ALL: process.env.LC_ALL || '',
    NO_COLOR: '1',
    NODE_NO_WARNINGS: '1',
  };
}

function invokeExtension(extension, capability, input, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      ...permissionArgs(),
      `--allow-fs-read=${RUNNER_PATH}`,
      `--allow-fs-read=${extension.entry}`,
      RUNNER_PATH,
    ];
    const child = spawn(process.execPath, args, {
      cwd: dirname(extension.entry),
      env: safeEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`Extension ${extension.id} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_RESULT_CHARS) {
        child.kill('SIGKILL');
        finish(reject, new Error(`Extension ${extension.id} output exceeded the safety limit.`));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > MAX_RESULT_CHARS) {
        child.kill('SIGKILL');
        finish(
          reject,
          new Error(`Extension ${extension.id} diagnostics exceeded the safety limit.`),
        );
      }
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', () => {
      if (settled) return;
      try {
        const response = JSON.parse(stdout.trim());
        if (!response?.ok) {
          throw new Error(response?.error || stderr.trim() || 'extension process failed');
        }
        finish(resolvePromise, response.result);
      } catch (error) {
        finish(
          reject,
          new Error(
            `Extension ${extension.id} failed: ${error.message}${stderr ? ` (${stderr.trim().slice(0, 500)})` : ''}`,
          ),
        );
      }
    });
    child.stdin.end(JSON.stringify({ entry: extension.entry, capability, input }));
  });
}

function containsCredentialField(value, depth = 0) {
  if (depth > 12 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsCredentialField(item, depth + 1));
  return Object.entries(value).some(
    ([key, item]) => SECRET_FIELD.test(key) || containsCredentialField(item, depth + 1),
  );
}

function safeAdapterConfig(config) {
  return {
    apiUrl: config.apiUrl,
    modelId: config.modelId,
    extraBody: config.extraBody,
    reasoning: config.reasoning,
  };
}

export async function createExtensionHost(settings) {
  validateExtensionsConfig(settings);
  const loaded = [];
  const ids = new Set();
  for (const path of settings.manifests) {
    const extension = await loadManifest(path);
    if (ids.has(extension.id)) throw new Error(`Duplicate extension id: ${extension.id}.`);
    ids.add(extension.id);
    loaded.push(extension);
  }
  if (loaded.length) permissionArgs();
  const byCapability = (name) => loaded.filter((item) => item.capabilities.includes(name));
  const findProvider = (providerType) => {
    const id = providerType.slice(10);
    const extension = loaded.find(
      (item) => item.id === id && item.capabilities.includes('providerAdapter'),
    );
    if (!extension)
      throw new Error(`Provider extension "${id}" is not installed or lacks providerAdapter.`);
    return extension;
  };

  return Object.freeze({
    extensions: loaded.map(({ id, version, capabilities }) => ({ id, version, capabilities })),
    async collectContext({ files = [], branch = '' }) {
      const parts = [];
      const warnings = [];
      for (const extension of byCapability('contextProvider')) {
        try {
          const result = await invokeExtension(
            extension,
            'contextProvider',
            {
              repository: basename(process.cwd()),
              branch: String(branch).slice(0, 300),
              files: files.slice(0, 500).map(({ status, path }) => ({
                status: String(status).slice(0, 10),
                path: String(path).slice(0, 500),
              })),
            },
            settings.timeoutMs,
          );
          if (!object(result) || typeof result.text !== 'string') {
            throw new Error('contextProvider must return { text, warnings? }.');
          }
          const remaining = settings.maxContextChars - parts.join('\n').length;
          if (remaining > 0 && result.text.trim()) {
            parts.push(`[extension:${extension.id}]\n${result.text.trim().slice(0, remaining)}`);
          }
          if (Array.isArray(result.warnings)) {
            warnings.push(
              ...result.warnings
                .filter((item) => typeof item === 'string')
                .slice(0, 10)
                .map((item) => `[extension:${extension.id}] ${item.slice(0, 500)}`),
            );
          }
        } catch (error) {
          warnings.push(`[extension:${extension.id}] context unavailable: ${error.message}`);
        }
      }
      return { text: parts.join('\n\n').slice(0, settings.maxContextChars), warnings };
    },
    async validateMessage(message, policy) {
      const issues = [];
      for (const extension of byCapability('messageValidator')) {
        const result = await invokeExtension(
          extension,
          'messageValidator',
          { message: String(message).slice(0, 20_000), policy },
          settings.timeoutMs,
        );
        if (!object(result) || !Array.isArray(result.issues)) {
          throw new Error(`Extension ${extension.id} messageValidator must return { issues: [] }.`);
        }
        for (const issue of result.issues.slice(0, 50)) {
          if (
            !object(issue) ||
            !['error', 'warning'].includes(issue.severity) ||
            typeof issue.code !== 'string' ||
            !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(issue.code) ||
            typeof issue.message !== 'string' ||
            !issue.message.trim()
          ) {
            throw new Error(`Extension ${extension.id} returned an invalid validation issue.`);
          }
          issues.push({
            severity: issue.severity,
            code: `extension:${extension.id}:${issue.code}`,
            message: `[extension:${extension.id}] ${issue.message.trim().slice(0, 500)}`,
          });
        }
      }
      return issues;
    },
    providerAdapter(config) {
      const extension = findProvider(config.providerType);
      const capabilities = Object.freeze({
        streaming: false,
        reasoning: 'configurable',
        tokenBudget: 'extension',
        usage: true,
        finishReason: true,
      });
      const call = (operation, input) =>
        invokeExtension(
          extension,
          'providerAdapter',
          { operation, config: safeAdapterConfig(config), ...input },
          settings.timeoutMs,
        );
      return Object.freeze({
        id: `extension:${extension.id}`,
        capabilities,
        headers: {},
        async buildRequest(request) {
          const payload = await call('buildRequest', { request });
          if (!object(payload))
            throw new Error('providerAdapter buildRequest must return an object.');
          if (containsCredentialField(payload)) {
            throw new Error('providerAdapter returned a credential-like request field.');
          }
          return payload;
        },
        async normalizeResponse(data) {
          const result = await call('normalizeResponse', { response: data });
          if (!object(result) || typeof result.content !== 'string') {
            throw new Error(
              'providerAdapter normalizeResponse must return an object with content.',
            );
          }
          return {
            provider: `extension:${extension.id}`,
            model: typeof result.model === 'string' ? result.model : null,
            content: result.content,
            reasoning: typeof result.reasoning === 'string' ? result.reasoning : null,
            usage: object(result.usage) ? result.usage : null,
            finishReason: typeof result.finishReason === 'string' ? result.finishReason : null,
            raw: data,
          };
        },
        async reasoningForFollowUp(reasoning) {
          const result = await call('reasoningForFollowUp', { reasoning });
          if (!object(result))
            throw new Error('providerAdapter reasoningForFollowUp must return an object.');
          return result;
        },
      });
    },
  });
}

export async function configureExtensionHost(config) {
  const host = await createExtensionHost(config.extensions);
  Object.defineProperty(config, EXTENSION_HOST, { value: host, enumerable: true });
  return host;
}

export function extensionHostFor(config) {
  return config?.[EXTENSION_HOST] || null;
}

export async function resolveProviderAdapter(config, builtInResolver) {
  if (isExtensionProviderType(config.providerType)) {
    const host = extensionHostFor(config);
    if (!host) throw new Error('Provider extension runtime is not configured.');
    return host.providerAdapter(config);
  }
  return builtInResolver(config);
}
