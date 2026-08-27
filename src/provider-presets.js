import { createRequire } from 'node:module';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isProviderType } from './providers.js';

const require = createRequire(import.meta.url);
const { version: CORE_VERSION } = require('../package.json');

export const PROVIDER_PRESET_KIND = 'aicommit-provider-presets';
export const PROVIDER_PRESET_SCHEMA_VERSION = 2;
export const PROVIDER_ADAPTER_CONTRACT_VERSION = 1;
export const BUNDLED_PROVIDER_PRESET_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../presets/provider-presets.json',
);

const MAX_PRESET_BYTES = 256 * 1024;
const MAX_EXTRA_BODY_DEPTH = 8;
const MAX_EXTRA_BODY_NODES = 500;
const STABLE_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PRERELEASE_IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const CORE_SEMVER_RE = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)` +
    `(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?` +
    '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const CREDENTIAL_KEY_RE =
  /^(?:authorization|proxy-authorization|api[-_]?key|access[-_]?token|bearer[-_]?token|token|secret(?:[-_]?key)?|client[-_]?secret|password)$/i;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, expected, path) {
  if (!object(value)) throw new Error(`${path} must be an object.`);
  const allowed = new Set(expected);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length)
    throw new Error(`${path} contains unknown properties: ${unknown.join(', ')}.`);
  if (missing.length) throw new Error(`${path} is missing properties: ${missing.join(', ')}.`);
}

function semverValue(value, path, { allowPrerelease = false } = {}) {
  const match =
    typeof value === 'string'
      ? value.match(allowPrerelease ? CORE_SEMVER_RE : STABLE_SEMVER_RE)
      : null;
  if (!match) {
    throw new Error(
      allowPrerelease
        ? `${path} must be a semantic version.`
        : `${path} must be a stable semantic version (x.y.z).`,
    );
  }
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left.numbers[index] !== right.numbers[index]) {
      return left.numbers[index] - right.numbers[index];
    }
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    if (!left.prerelease.length && !right.prerelease.length) return 0;
    return left.prerelease.length ? -1 : 1;
  }
  const count = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < count; index++) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const normalizedLeft = leftPart.replace(/^0+(?=\d)/, '');
      const normalizedRight = rightPart.replace(/^0+(?=\d)/, '');
      if (normalizedLeft.length !== normalizedRight.length) {
        return normalizedLeft.length - normalizedRight.length;
      }
      if (normalizedLeft === normalizedRight) continue;
      return normalizedLeft < normalizedRight ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function assertExtraBody(value, path = 'provider.extraBody', depth = 0, state = { nodes: 0 }) {
  state.nodes += 1;
  if (state.nodes > MAX_EXTRA_BODY_NODES) throw new Error(`${path} is too complex.`);
  if (depth > MAX_EXTRA_BODY_DEPTH) throw new Error(`${path} is nested too deeply.`);
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error(`${path} has too many array items.`);
    value.forEach((item, index) => assertExtraBody(item, `${path}[${index}]`, depth + 1, state));
    return;
  }
  if (!object(value)) throw new Error(`${path} must contain JSON-compatible values.`);
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error(`${path} has too many properties.`);
  for (const [key, item] of entries) {
    if (
      FORBIDDEN_JSON_KEYS.has(key) ||
      CREDENTIAL_KEY_RE.test(key) ||
      (depth === 0 && (key === 'model' || key === 'messages'))
    ) {
      throw new Error(`${path} contains forbidden property: ${key}.`);
    }
    assertExtraBody(item, `${path}.${key}`, depth + 1, state);
  }
}

function securePresetUrl(value) {
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname.startsWith('127.') ||
      url.hostname === '[::1]';
    const secureTransport = url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
    return secureTransport && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function validateProviderPresetManifest(value) {
  assertExactKeys(
    value,
    ['kind', 'schemaVersion', 'version', 'compatibility', 'providers'],
    'Provider preset manifest',
  );
  if (value.kind !== PROVIDER_PRESET_KIND) {
    throw new Error(`Provider preset kind must be "${PROVIDER_PRESET_KIND}".`);
  }
  if (value.schemaVersion !== PROVIDER_PRESET_SCHEMA_VERSION) {
    throw new Error(`Provider preset schemaVersion must be ${PROVIDER_PRESET_SCHEMA_VERSION}.`);
  }
  semverValue(value.version, 'Provider preset version');
  assertExactKeys(
    value.compatibility,
    ['coreMinimum', 'coreMaximumExclusive', 'adapterContract'],
    'Provider preset compatibility',
  );
  const minimum = semverValue(value.compatibility.coreMinimum, 'compatibility.coreMinimum');
  const maximum = semverValue(
    value.compatibility.coreMaximumExclusive,
    'compatibility.coreMaximumExclusive',
  );
  if (compareVersions(minimum, maximum) >= 0) {
    throw new Error('Provider preset compatibility range is empty.');
  }
  if (value.compatibility.adapterContract !== PROVIDER_ADAPTER_CONTRACT_VERSION) {
    throw new Error(
      `Provider preset adapterContract must be ${PROVIDER_ADAPTER_CONTRACT_VERSION}.`,
    );
  }
  if (!Array.isArray(value.providers) || !value.providers.length || value.providers.length > 100) {
    throw new Error('Provider preset providers must contain 1-100 entries.');
  }
  const ids = new Set();
  for (const [index, provider] of value.providers.entries()) {
    const path = `Provider preset providers[${index}]`;
    const required = ['id', 'label', 'adapter', 'apiUrl', 'defaultModel', 'models'];
    assertExactKeys(provider, required, path);
    if (
      !ID_RE.test(provider.id) ||
      provider.id.toLowerCase() === 'custom' ||
      ids.has(provider.id)
    ) {
      throw new Error(
        `${path}.id must be unique and use letters, digits, dot, dash, or underscore.`,
      );
    }
    ids.add(provider.id);
    if (
      typeof provider.label !== 'string' ||
      !provider.label.trim() ||
      provider.label.length > 80 ||
      /[\0-\x1f\x7f]/.test(provider.label)
    ) {
      throw new Error(`${path}.label must be a non-empty string of at most 80 characters.`);
    }
    if (!isProviderType(provider.adapter) || provider.adapter !== provider.adapter.toLowerCase()) {
      throw new Error(`${path}.adapter is not supported by adapter contract v1.`);
    }
    if (
      !securePresetUrl(provider.apiUrl) ||
      provider.apiUrl.length > 2048 ||
      /[\0-\x1f\x7f]/.test(provider.apiUrl)
    ) {
      throw new Error(
        `${path}.apiUrl must be credential-free HTTPS, or HTTP only for localhost/loopback, without query or fragment.`,
      );
    }
    if (!ID_RE.test(provider.defaultModel)) {
      throw new Error(`${path}.defaultModel must be a valid model name.`);
    }
    if (
      !object(provider.models) ||
      !Object.keys(provider.models).length ||
      Object.keys(provider.models).length > 100
    ) {
      throw new Error(`${path}.models must contain 1-100 named models.`);
    }
    if (!Object.hasOwn(provider.models, provider.defaultModel)) {
      throw new Error(`${path}.defaultModel must reference a model in ${path}.models.`);
    }
    for (const [modelName, model] of Object.entries(provider.models)) {
      const modelPath = `${path}.models.${modelName}`;
      if (!ID_RE.test(modelName)) throw new Error(`${modelPath} has an invalid model name.`);
      const modelKeys = ['modelId'];
      if (Object.hasOwn(model || {}, 'label')) modelKeys.push('label');
      if (Object.hasOwn(model || {}, 'extraBody')) modelKeys.push('extraBody');
      assertExactKeys(model, modelKeys, modelPath);
      if (
        typeof model.modelId !== 'string' ||
        !model.modelId.trim() ||
        model.modelId.length > 256 ||
        /[\0-\x1f\x7f]/.test(model.modelId)
      ) {
        throw new Error(
          `${modelPath}.modelId must be a non-empty string of at most 256 characters.`,
        );
      }
      if (
        Object.hasOwn(model, 'label') &&
        (typeof model.label !== 'string' ||
          !model.label.trim() ||
          model.label.length > 80 ||
          /[\0-\x1f\x7f]/.test(model.label))
      ) {
        throw new Error(`${modelPath}.label must be a non-empty string of at most 80 characters.`);
      }
      if (Object.hasOwn(model, 'extraBody')) {
        if (!object(model.extraBody)) throw new Error(`${modelPath}.extraBody must be an object.`);
        assertExtraBody(model.extraBody, `${modelPath}.extraBody`);
      }
    }
  }
  return value;
}

export function assertProviderPresetCompatibility(value, coreVersion = CORE_VERSION) {
  validateProviderPresetManifest(value);
  const core = semverValue(coreVersion, 'Core version', { allowPrerelease: true });
  const minimum = semverValue(value.compatibility.coreMinimum, 'compatibility.coreMinimum');
  const maximum = semverValue(
    value.compatibility.coreMaximumExclusive,
    'compatibility.coreMaximumExclusive',
  );
  if (compareVersions(core, minimum) < 0 || compareVersions(core, maximum) >= 0) {
    throw new Error(
      `Provider preset v${value.version} requires aicommit >=${value.compatibility.coreMinimum} and <${value.compatibility.coreMaximumExclusive}; current core is ${coreVersion}.`,
    );
  }
  return value;
}

async function readManifest(path, coreVersion) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Provider preset must be a regular non-symlinked file: ${path}`);
  }
  if (info.size > MAX_PRESET_BYTES) {
    throw new Error(`Provider preset exceeds 256 KiB: ${path}`);
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse provider preset ${path}: ${err.message}`, { cause: err });
  }
  assertProviderPresetCompatibility(value, coreVersion);
  return value;
}

export async function loadProviderPresetManifest({ path = null, coreVersion } = {}) {
  const selected = path ? resolve(path) : BUNDLED_PROVIDER_PRESET_PATH;
  return {
    manifest: await readManifest(selected, coreVersion),
    path: selected,
    source: path ? 'file' : 'bundled',
  };
}
