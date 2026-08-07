import { access } from 'node:fs/promises';

export async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

export function deepMerge(a, b) {
  const result = { ...a };
  for (const key of Object.keys(b)) {
    if (
      b[key] && typeof b[key] === 'object' && !Array.isArray(b[key]) &&
      a[key] && typeof a[key] === 'object' && !Array.isArray(a[key])
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
// Also strips inline <think>...</think> blocks — MiniMax embeds thinking
// this way in `content` when thinking is enabled (M2.x can't disable it).
export function cleanCommitMessage(msg) {
  const cleaned = msg.replace(/<think>[\s\S]*?<\/think>/g, '');
  const lines = cleaned.trim().split('\n');
  if (lines.length > 0 && /^\s*```[a-zA-Z]*\s*$/.test(lines[0])) lines.shift();
  if (lines.length > 0 && /^\s*```\s*$/.test(lines[lines.length - 1])) lines.pop();
  return lines.join('\n').trim();
}

export function formatMs(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Round a raw token count to the precision it's displayed at, expressed in k
// (M-scale counts stay in k here — 1.2M = 1200k — so the parts can be summed).
function roundedK(n) {
  const k = n / 1_000;
  return +(k.toFixed(k < 0.1 ? 2 : 1));
}

// Render a k value with units — "0.9k", "6.8k", or "1.2M" once >= 1000k.
// The leading `+` strips a trailing ".0" so 7k renders as "7k", not "7.0k".
function renderK(k) {
  if (k >= 1_000) return `${+(k / 1_000).toFixed(1)}M`;
  return `${+(k.toFixed(k < 0.1 ? 2 : 1))}k`;
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
export function formatUsage(usage) {
  const hasBreakdown =
    typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number';
  if (hasBreakdown) {
    const p = roundedK(usage.prompt_tokens);
    const c = roundedK(usage.completion_tokens);
    return `${renderK(p)} in + ${renderK(c)} out (total ${renderK(p + c)})`;
  }
  if (typeof usage.total_tokens === 'number') return `${formatTokens(usage.total_tokens)}`;
  return '';
}

// Indent every line of an error message by two spaces, so multi-line API
// errors align under the surrounding CLI indentation.
export function indentError(err) {
  return err.message.split('\n').join('\n  ');
}

export function maskApiKey(key) {
  if (!key) return '(not set)';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)} (${key.length} chars)`;
}
