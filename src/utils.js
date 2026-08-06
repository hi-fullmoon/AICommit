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
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Abbreviate a token count with k/M units — k is the smallest unit shown,
// so even sub-thousand counts render as 0.xk. Sub-0.1k counts keep a second
// decimal so tiny values (e.g. the ping check) don't collapse to "0k".
function formatTokens(n) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  const k = n / 1_000;
  // The leading `+` strips a trailing ".0" so 7000 renders as "7k", not "7.0k".
  return `${+(k.toFixed(k < 0.1 ? 2 : 1))}k`;
}

// "6.8k+900 (7.7k)" — prompt + completion, with the total appended. Uses the
// provider-reported total_tokens when present, else derives it from the parts.
export function formatUsage(usage) {
  const hasBreakdown =
    typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number';
  if (hasBreakdown) {
    const total = usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens;
    return `${formatTokens(usage.prompt_tokens)}+${formatTokens(usage.completion_tokens)} (${formatTokens(total)})`;
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
