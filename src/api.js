import { cleanCommitMessage } from './utils.js';

// Default per-request timeout; overridable via the "timeoutMs" config key.
const DEFAULT_TIMEOUT_MS = 120_000;

// OpenAI's own API strict-validates the request body — unknown params get a
// 400 ("Unrecognized request argument supplied") — and its reasoning families
// (o-series, gpt-5*) reject "max_tokens" and a non-default temperature, taking
// "max_completion_tokens" instead. Other vendors ignore unknown params, so
// the thinking-disable switches are only sent off OpenAI's endpoint.
function isOpenAIEndpoint(apiUrl) {
  try { return new URL(apiUrl).hostname === 'api.openai.com'; } catch { return false; }
}

function isOpenAIReasoningModel(modelId) {
  const id = (modelId || '').split('/').pop(); // strip router prefixes like "openai/"
  return /^(?:o\d|gpt-5)/i.test(id);
}

export async function callAPI(apiUrl, apiKey, modelId, messages, temperature, maxTokens, timeoutMs) {
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  const payload = { model: modelId, messages };
  if (isOpenAIReasoningModel(modelId)) {
    payload.max_completion_tokens = maxTokens;
  } else {
    payload.temperature = temperature;
    payload.max_tokens = maxTokens;
  }
  if (!isOpenAIEndpoint(apiUrl)) {
    // Disable thinking across vendors; unknown params are ignored by
    // APIs that don't support them:
    // - enable_thinking: Qwen-style switch
    // - thinking.type=disabled: MiniMax OpenAI-compatible API (M3)
    // - reasoning_split: MiniMax M2.x can't disable thinking, but this moves
    //   the reasoning out of `content` into `reasoning_details`
    payload.enable_thinking = false;
    payload.thinking = { type: 'disabled' };
    payload.reasoning_split = true;
  }
  const body = JSON.stringify(payload);

  let response;
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        // Identify the app to OpenRouter (ignored by other providers).
        'X-Title': 'aicommit',
      },
      body,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error(
        `Request timed out after ${Math.round(timeout / 1000)}s — the model took too long to respond. ` +
        `Raise "timeoutMs" in your config if this keeps happening.`,
      );
    }
    throw err;
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errText.slice(0, 400)}`);
  }

  return response.json();
}

// Minimal "ping" request to verify the endpoint, API key, and model are all
// reachable. Throws on HTTP errors (same as callAPI); returns latency, the
// echoed model id, and a preview of the model's reply. Uses the same request
// body as a real call, so it validates the actual path a commit would take.
export async function checkConnection(config) {
  const { apiUrl, apiKey, modelId, maxTokens, timeoutMs } = config;
  const t0 = performance.now();

  const data = await callAPI(
    apiUrl,
    apiKey,
    modelId,
    [{ role: 'user', content: 'Reply with exactly: OK' }],
    0,
    Math.min(maxTokens || 1024, 64),
    timeoutMs,
  );

  const content = extractMessage(data);

  return {
    elapsed: performance.now() - t0,
    model: data?.model || null,
    content: content.trim(),
    usage: data?.usage || null,
  };
}

// Conventional-commit prefix, matched anywhere in a line (not just at line
// start), so "final answer: feat: x" is found as easily as "feat: x".
const COMMIT_TYPE_RE = /\b(?:feat|fix|chore|docs|refactor|test|style|perf|ci|build)[\w]*[!:]/i;

// Tail of reasoning sent back in a follow-up call. The conclusion lives at
// the end; re-sending a whole trace (sometimes tens of thousands of tokens)
// would be slow and expensive for no benefit.
const MAX_REASONING_CHARS = 8000;

// Strict first-line check that decides whether a corrective retry is
// worthwhile: a conventional commit starts with a known type, an optional
// scope, optional "!", then ": ". Weak models often return prose ("Updated
// the login page") or a quoted message — both fail here and earn one retry.
const CONVENTIONAL_SUBJECT_RE = /^(?:feat|fix|chore|docs|refactor|test|style|perf|ci|build)(?:\([\w./-]+\))?!?: \S/i;

// Prompt for the corrective retry: the model already produced the right
// content in the wrong shape, so the diff is NOT re-sent — reformatting the
// bad reply is enough, and far cheaper than a second full-diff call.
function correctivePrompt(badReply) {
  return [
    'Your previous reply was not a valid conventional commit message:',
    '',
    badReply.slice(0, 1000),
    '',
    'Rewrite it as a conventional commit message: first line "<type>: <subject>" ' +
    '(type one of feat, fix, chore, docs, refactor, test, style, perf, ci, build), ' +
    'then an optional body after a blank line. ' +
    'Output ONLY the rewritten message — no explanation, no quotes, no code fences.',
  ].join('\n');
}

// Read the assistant text from either OpenAI format
// (choices[0].message.content, possibly an array of parts) or Anthropic
// format (content[0].text).
function extractMessage(data) {
  const oai = data?.choices?.[0]?.message?.content;
  if (typeof oai === 'string') return oai;
  if (Array.isArray(oai)) return oai.map(p => p?.text ?? '').filter(Boolean).join('');
  return data?.content?.[0]?.text ?? '';
}

// Normalize reasoning from the vendor-specific fields that can carry it:
// OpenAI-style `reasoning_content` (DeepSeek), OpenRouter-style `reasoning`,
// MiniMax/OpenRouter-style `reasoning_details` ([{ type: 'thinking', text }],
// possibly multiple segments with interleaved thinking).
function extractReasoning(msg0) {
  return msg0?.reasoning_content
    || msg0?.reasoning
    || msg0?.reasoning_details?.map(d => d?.text).filter(Boolean).join('\n')
    || null;
}

// Last-ditch extraction from raw reasoning text: prefer the first line that
// carries a conventional-commit prefix, else fall back to the last non-empty
// line.
function extractFromReasoning(reasoning) {
  const lines = reasoning.split('\n');
  for (const line of lines) {
    const idx = line.search(COMMIT_TYPE_RE);
    if (idx !== -1) return line.slice(idx).trim();
  }
  const nonEmpty = lines.filter(l => l.trim());
  return nonEmpty[nonEmpty.length - 1]?.trim() || '';
}

// Prompt for the follow-up call when a reasoning model returned only a
// reasoning trace and no content.
const FOLLOWUP_COMMIT_PROMPT =
  'Based on your analysis above, output ONLY the final conventional commit message ' +
  '(e.g. feat:, fix:, chore:, docs:, refactor:, test:, style:, perf:, ci:, build:). ' +
  'Do not include any other text, explanation, or code fences.';

// Combine usage across every API call in one round. Reasoning models can
// trigger a follow-up call (see getResponseText); summing both keeps the
// reported token count honest instead of dropping the reasoning tokens.
function sumUsage(...usages) {
  const total = {};
  for (const u of usages) {
    if (!u) continue;
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
      if (typeof u[key] === 'number') total[key] = (total[key] || 0) + u[key];
    }
  }
  return Object.keys(total).length ? total : null;
}

// Make the API call and return the assistant text plus the first response's
// reasoning. Reasoning models that can't disable thinking (MiniMax M2.x,
// DeepSeek R1, OpenRouter reasoning models) may return empty content with a
// reasoning trace; in that case a follow-up call feeds the (truncated) tail of
// the reasoning back as context so the model produces the final answer — the
// original messages (which include the full diff) are NOT re-sent, since the
// reasoning tail already carries the model's own analysis of them.
// Shared by the commit flow and the split flow. `usage` aggregates the token
// counts of every call made in the round.
export async function getResponseText(config, messages, temperature, maxTokens, followUpPrompt) {
  let data = await callAPI(config.apiUrl, config.apiKey, config.modelId, messages, temperature, maxTokens, config.timeoutMs);
  const usages = [data?.usage];
  const reasoning = extractReasoning(data?.choices?.[0]?.message);
  let text = extractMessage(data);

  if (!text.trim() && reasoning) {
    const truncated = reasoning.length > MAX_REASONING_CHARS
      ? '…' + reasoning.slice(-MAX_REASONING_CHARS)
      : reasoning;

    // Don't re-send the original messages — the user message is the full diff,
    // which can be tens of thousands of tokens. The reasoning tail already
    // contains the model's analysis of it; keep only the (cheap) system prompt
    // for language/format constraints, then the reasoning + the follow-up ask.
    const systemMsg = messages.find(m => m.role === 'system');
    data = await callAPI(config.apiUrl, config.apiKey, config.modelId, [
      ...(systemMsg ? [systemMsg] : []),
      { role: 'assistant', content: truncated },
      { role: 'user', content: followUpPrompt },
    ], temperature, maxTokens, config.timeoutMs);
    usages.push(data?.usage);
    text = extractMessage(data);
  }

  return { text, data, reasoning, usage: sumUsage(...usages) };
}

export async function generateCommitMessage(config, diff, regenerateCount = 0) {
  const { prompt, temperature, language, maxTokens } = config;
  const t0 = performance.now();

  // Build the language directive — appended after the (possibly custom)
  // prompt so it takes priority over conflicting language instructions in it.
  // It must explicitly override the examples' language too: a custom prompt
  // full of Chinese few-shot examples makes weak models mimic the examples'
  // language over an abstract instruction.
  const targetLang = language === 'zh' ? 'Simplified Chinese' : 'English';
  const langHint =
    `\n\nIMPORTANT: Write the ENTIRE commit message (subject AND body) in ${targetLang}, ` +
    `regardless of the language used in any instructions or examples above — ` +
    `examples show the format only, never the language.`;

  // Weak models weigh the end of the request most, so repeat the language
  // constraint after the diff where it can't be drowned out by the prompt.
  const langReminder = `\n\n(Remember: the commit message must be in ${targetLang}.)`;

  // On regenerate, vary the prompt and temperature to get a different result
  const variationHint = regenerateCount > 0
    ? `\n(Attempt #${regenerateCount + 1}: please produce a DIFFERENT commit message than before.)`
    : '';
  const variedTemperature = Math.min(temperature + regenerateCount * 0.15, 1.2);

  const messages = [
    { role: 'system', content: prompt + langHint },
    { role: 'user',    content: `Here is the git diff:\n\n\`\`\`diff\n${diff}\n\`\`\`` + variationHint + langReminder },
  ];

  const { text, data, reasoning, usage: firstUsage } = await getResponseText(
    config, messages, variedTemperature, maxTokens, FOLLOWUP_COMMIT_PROMPT,
  );
  let usage = firstUsage;
  let message = text;

  // Last resort: extract a message from the reasoning content itself
  if (!message.trim() && reasoning) {
    message = extractFromReasoning(reasoning);
  }
  message = cleanCommitMessage(message);

  // Weak models sometimes answer with prose or a quoted message instead of a
  // conventional commit. Give the model one cheap chance to reformat its own
  // reply; keep whatever comes back — a non-empty reply beats nothing.
  if (message.trim() && !CONVENTIONAL_SUBJECT_RE.test(message.split('\n', 1)[0])) {
    const retry = await getResponseText(
      config,
      [messages[0], { role: 'user', content: correctivePrompt(message) }],
      variedTemperature, maxTokens, FOLLOWUP_COMMIT_PROMPT,
    );
    const fixed = cleanCommitMessage(retry.text);
    // The retry is a real API call that cost tokens regardless of whether it
    // produced a usable message — count its usage unconditionally.
    usage = sumUsage(usage, retry.usage);
    if (fixed.trim()) {
      message = fixed;
    }
  }

  const elapsed = performance.now() - t0;

  if (!message.trim()) {
    const snippet = JSON.stringify(data, null, 2).slice(0, 600);
    throw new Error(
      `API returned an empty commit message.\n` +
      `  The request succeeded but no text came back — the model may have spent ` +
      `its token budget on reasoning (maxTokens: ${maxTokens}).\n` +
      `  Try raising "maxTokens" in your config.\n\nRaw response:\n${snippet}`,
    );
  }

  return { message: cleanCommitMessage(message), elapsed, usage };
}
