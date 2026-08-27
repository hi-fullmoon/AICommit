import { access } from 'node:fs/promises';

export async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Treat model output, provider errors, Git paths, and config values as
// untrusted terminal text. OSC/CSI and other escape/control sequences can
// clear the screen, forge prompts, or interact with terminal features such as
// clipboard integration. Preserve only ordinary text, tabs, and newlines.
export function sanitizeTerminalText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[P^_][\s\S]*?\x1B\\/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B./g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
}

// Plain-object keys merge recursively; scalars are overwritten; arrays are
// concatenated and deduped rather than replaced, so a project-level
// "stripFiles" extends the user-level list instead of wiping it.
export function deepMerge(a, b) {
  const result = { ...a };
  for (const key of Object.keys(b)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    if (Array.isArray(a[key]) && Array.isArray(b[key])) {
      result[key] = [...new Set([...a[key], ...b[key]])];
    } else if (
      b[key] &&
      typeof b[key] === 'object' &&
      !Array.isArray(b[key]) &&
      a[key] &&
      typeof a[key] === 'object' &&
      !Array.isArray(a[key])
    ) {
      result[key] = deepMerge(a[key], b[key]);
    } else {
      result[key] = b[key];
    }
  }
  return result;
}

// Strip markdown code fences the model sometimes wraps around the message
// (e.g. "```\nfix: ...\n```" or "```text\n...\n```"), plus stray backticks.
// The fence may share a line with the message ("``` feat: ..."), so strip a
// leading/trailing fence prefix/suffix instead of only dropping whole lines.
// Also strips inline <think>...</think> blocks — MiniMax embeds thinking
// this way in `content` when thinking is enabled (M2.x can't disable it).
export function cleanCommitMessage(msg) {
  const cleaned = sanitizeTerminalText(msg).replace(/<think>[\s\S]*?<\/think>/g, '');
  return cleaned
    .trim()
    .replace(/^\s*```[a-zA-Z]*(?:\s+|$)/, '') // opening fence, even with content on the same line
    .replace(/\s*```\s*$/, '') // closing fence, even with content on the same line
    .trim();
}

const CONVENTIONAL_COMMIT_RE =
  /^(?:feat|fix|chore|docs|refactor|test|style|perf|ci|build)(?:\([\w./-]+\))?!?: \S/i;

export function isValidCommitMessage(message, maxSubjectLength = 100) {
  const cleaned = cleanCommitMessage(message);
  const subject = cleaned.split('\n', 1)[0];
  return (
    Boolean(cleaned) && subject.length <= maxSubjectLength && CONVENTIONAL_COMMIT_RE.test(subject)
  );
}

export function formatMs(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Round a raw token count to the precision it's displayed at, expressed in k
// (M-scale counts stay in k here — 1.2M = 1200k — so the parts can be summed).
function roundedK(n) {
  const k = n / 1_000;
  return +k.toFixed(k < 0.1 ? 2 : 1);
}

// Render a k value with units — "0.9k", "6.8k", or "1.2M" once >= 1000k.
// The leading `+` strips a trailing ".0" so 7k renders as "7k", not "7.0k".
function renderK(k) {
  if (k >= 1_000) return `${+(k / 1_000).toFixed(1)}M`;
  return `${+k.toFixed(k < 0.1 ? 2 : 1)}k`;
}

// Abbreviate a token count with k/M units — k is the smallest unit shown,
// so even sub-thousand counts render as 0.xk. Sub-0.1k counts keep a second
// decimal so tiny values (e.g. the ping check) don't collapse to "0k".
function formatTokens(n) {
  return renderK(roundedK(n));
}

// "4k in + 0.5k out (total 4.5k)" — labeled prompt/input and completion/output
// split, with the total appended. The total is the sum of the *displayed*
// parts, not the raw total rounded on its own, so in + out always equals it
// (1.6k + 0.3k = 1.9k, never a mismatch like "1.6k+0.3k (total 2k)").
// Accepts the internal camelCase contract plus legacy provider field names.
export function formatUsage(usage) {
  const prompt = usage.inputTokens ?? usage.prompt_tokens ?? usage.input_tokens;
  const completion = usage.outputTokens ?? usage.completion_tokens ?? usage.output_tokens;
  if (typeof prompt === 'number' && typeof completion === 'number') {
    const p = roundedK(prompt);
    const c = roundedK(completion);
    return `${renderK(p)} in + ${renderK(c)} out (total ${renderK(p + c)})`;
  }
  const total = usage.totalTokens ?? usage.total_tokens;
  if (typeof total === 'number') return `${formatTokens(total)}`;
  return '';
}

// Indent every line of an error message by two spaces, so multi-line API
// errors align under the surrounding CLI indentation.
export function indentError(err) {
  return sanitizeTerminalText(err?.message || err)
    .split('\n')
    .join('\n  ');
}

export function maskApiKey(key) {
  if (!key) return '(not set)';
  if (key.length <= 8) return '****';
  const safe = sanitizeTerminalText(key);
  return `${safe.slice(0, 4)}…${safe.slice(-4)} (${key.length} chars)`;
}

const SENSITIVE_CONFIG_KEY_RE =
  /^(?:api[_-]?key|access[_-]?token|authorization|client[_-]?secret|password|passwd|secret|token)$/i;
const SENSITIVE_URL_PARAMETER_RE =
  /^(?:api[-_]?key|key|x[-_]?api[-_]?key|access[-_]?token|refresh[-_]?token|bearer[-_]?token|token|authorization|auth|password|passwd|secret(?:[-_]?key)?|client[-_]?secret|credential|signature|sig|code|subscription[-_]?key|x-amz-(?:credential|signature|security-token)|x-goog-signature)$/i;

// Provider endpoints occasionally need non-secret query parameters such as
// `api-version`, but credentials embedded in userinfo or well-known secret
// parameters must never be echoed to terminals, JSON inspection output, or
// diagnostics. Fragments are omitted because HTTP never sends them.
export function redactSensitiveUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.username) url.username = 'redacted';
    if (url.password) url.password = 'redacted';
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_URL_PARAMETER_RE.test(key)) url.searchParams.set(key, 'redacted');
    }
    url.hash = '';
    return url.toString();
  } catch {
    return sanitizeTerminalText(value);
  }
}

export function stringifyConfigRedacted(value) {
  return JSON.stringify(value, (key, item) => {
    if (/^apiUrl$/i.test(key) && typeof item === 'string') return redactSensitiveUrl(item);
    if (!SENSITIVE_CONFIG_KEY_RE.test(key)) return item;
    return typeof item === 'string' ? maskApiKey(item) : '[REDACTED]';
  });
}
