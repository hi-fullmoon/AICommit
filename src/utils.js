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

export function formatUsage(usage) {
  return `${usage.prompt_tokens}+${usage.completion_tokens}`;
}

export function maskApiKey(key) {
  if (!key) return '(not set)';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)} (${key.length} chars)`;
}
