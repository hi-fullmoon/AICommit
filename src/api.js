import { cleanCommitMessage } from './utils.js';

// Default per-request timeout; overridable via the "timeoutMs" config key.
const DEFAULT_TIMEOUT_MS = 120_000;

function isOpenAIReasoningModel(modelId) {
  const id = (modelId || '').split('/').pop(); // strip router prefixes like "openai/"
  return /^(?:o\d|gpt-5)/i.test(id);
}

function openAIReasoningEfforts(modelId) {
  const id = (modelId || '').split('/').pop().toLowerCase();

  // OpenAI adds effort levels by model generation. Keep this table explicit
  // so a provider-neutral CLI value cannot turn into a vague HTTP 400. Model
  // snapshots and tier suffixes (for example gpt-5.6-sol) share the same
  // generation prefix and therefore match these expressions as well.
  if (/^gpt-5\.6(?:-|$)/.test(id)) return ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (/^gpt-5\.(?:2|3|4|5)(?:-|$)/.test(id)) return ['none', 'low', 'medium', 'high', 'xhigh'];
  if (/^gpt-5\.1(?:-|$)/.test(id)) return ['none', 'low', 'medium', 'high'];
  if (/^gpt-5(?:-|$)/.test(id) || /^o\d(?:-|$)/.test(id)) return ['low', 'medium', 'high'];
  return null;
}

function openAIReasoningEffort(modelId, enabled, effort) {
  const requested = enabled ? effort : 'none';
  const supported = openAIReasoningEfforts(modelId);
  if (!supported || supported.includes(requested)) return requested;

  const action = enabled
    ? `reasoning effort "${requested}"`
    : 'disabling reasoning';
  throw new Error(
    `OpenAI model "${modelId}" does not support ${action}. ` +
    `Supported reasoning efforts: ${supported.join(', ')}.`,
  );
}

function endpointHost(apiUrl) {
  try { return new URL(apiUrl).hostname.toLowerCase(); } catch { return ''; }
}

function mergeRequestExtensions(payload, extensions) {
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) return;
  const { model: _model, messages: _messages, ...safe } = extensions;
  Object.assign(payload, safe);
}

// Map the provider-neutral reasoning config onto known Chat Completions
// dialects. Unknown strict-compatible endpoints stay untouched unless the
// user supplies enabledBody/disabledBody explicitly.
function applyReasoningOptions(payload, apiUrl, modelId, reasoning) {
  const mode = reasoning?.mode || 'auto';
  if (mode === 'auto') return;

  const enabled = mode === 'on';
  const effort = reasoning?.effort || 'medium';
  const host = endpointHost(apiUrl);

  if (host === 'api.openai.com') {
    if (!isOpenAIReasoningModel(modelId)) {
      // Reasoning is enabled by default at the app level, but classic models
      // such as GPT-4o do not accept reasoning_effort. Leave their standard
      // request untouched instead of making the default configuration fail.
      return;
    }
    payload.reasoning_effort = openAIReasoningEffort(modelId, enabled, effort);
    return;
  }

  if (host === 'api.deepseek.com' || host.endsWith('.deepseek.com')) {
    payload.thinking = { type: enabled ? 'enabled' : 'disabled' };
    if (enabled) {
      // DeepSeek V4 accepts low/high/max. Its documented mapping treats
      // medium and xhigh as high, so normalize our cross-provider levels.
      payload.reasoning_effort = effort === 'low' || effort === 'max' ? effort : 'high';
      // Thinking mode ignores temperature; omit it to keep the wire request
      // faithful to the native API instead of sending a misleading control.
      delete payload.temperature;
    } else {
      delete payload.reasoning_effort;
    }
    return;
  }

  if (host === 'openrouter.ai') {
    payload.reasoning = { effort: enabled ? effort : 'none' };
    return;
  }

  if (host.includes('minimax')) {
    payload.reasoning_split = true;
    if (enabled) {
      // MiniMax reasoning models think by default when the disabling switch is
      // omitted; reasoning_split keeps the trace out of final content.
      delete payload.thinking;
      delete payload.enable_thinking;
    } else {
      payload.thinking = { type: 'disabled' };
    }
    return;
  }

  const customBody = enabled ? reasoning?.enabledBody : reasoning?.disabledBody;
  if (customBody !== undefined) {
    mergeRequestExtensions(payload, customBody);
    return;
  }

  // Unknown OpenAI-compatible endpoints may expose reasoning without a
  // request switch, or may not support it at all. The default-on setting must
  // remain backwards compatible in both cases: leave the payload standard
  // unless the provider explicitly supplies enabledBody/disabledBody.
}

export async function callAPI(
  apiUrl, apiKey, modelId, messages, temperature, maxTokens, timeoutMs,
  extraBody = {}, reasoning = null, stream = null,
) {
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  const payload = { model: modelId, messages };
  if (isOpenAIReasoningModel(modelId)) {
    payload.max_completion_tokens = maxTokens;
  } else {
    payload.temperature = temperature;
    payload.max_tokens = maxTokens;
  }
  // OpenAI-compatible only describes the common schema; many compatible
  // servers reject unknown provider-specific fields. Keep the default body
  // standard and merge extensions only when the config/preset opts into them.
  mergeRequestExtensions(payload, extraBody);
  applyReasoningOptions(payload, apiUrl, modelId, reasoning);
  if (stream?.onReasoningDelta) {
    payload.stream = true;
    if (endpointHost(apiUrl) === 'api.openai.com') {
      const current = payload.stream_options;
      payload.stream_options = {
        ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
        include_usage: true,
      };
    }
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

  try {
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errText.slice(0, 400)}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (payload.stream && contentType.includes('text/event-stream')) {
      return consumeEventStream(response, stream.onReasoningDelta);
    }

    // A few compatible endpoints ignore stream=true and return regular JSON.
    // Keep accepting that response and surface its complete reasoning once.
    const data = await response.json();
    if (stream?.onReasoningDelta) {
      const completeReasoning = extractReasoning(data?.choices?.[0]?.message);
      if (completeReasoning) stream.onReasoningDelta(completeReasoning);
    }
    return data;
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(
        `Request timed out after ${Math.round(timeout / 1000)}s — the model took too long to respond. ` +
        `Raise "timeoutMs" in your config if this keeps happening.`,
      );
    }
    throw err;
  }
}

function streamContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(part => part?.text ?? part?.content ?? '').filter(Boolean).join('');
  }
  return value?.text ?? '';
}

// Consume OpenAI-compatible SSE (`data: {...}` / `data: [DONE]`) while
// assembling a normal Chat Completions-shaped response for the existing
// parsing and retry pipeline. Reasoning fields differ by provider, so every
// delta goes through the same normalization used for non-stream responses.
async function consumeEventStream(response, onReasoningDelta) {
  if (!response.body) throw new Error('Streaming response did not include a body.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines = [];
  let content = '';
  let reasoning = '';
  let usage = null;
  let model = null;
  let finishReason = null;
  let completed = false;

  const consumeData = (raw) => {
    const payloadText = raw.trim();
    if (!payloadText) return;
    if (payloadText === '[DONE]') {
      completed = true;
      return;
    }

    let event;
    try {
      event = JSON.parse(payloadText);
    } catch {
      throw new Error(`Invalid JSON in streaming response: ${payloadText.slice(0, 200)}`);
    }
    if (event.error) {
      const message = event.error.message || JSON.stringify(event.error);
      throw new Error(`Streaming API error: ${message}`);
    }

    model ||= event.model || null;
    if (event.usage) usage = event.usage;
    const finishedChoice = event?.choices?.find(choice => choice?.finish_reason != null);
    if (finishedChoice) {
      completed = true;
      finishReason ||= finishedChoice.finish_reason;
    }
    const delta = event?.choices?.[0]?.delta ?? event?.choices?.[0]?.message;
    if (!delta) return;

    content += streamContent(delta.content);
    const reasoningDelta = extractReasoning(delta);
    if (reasoningDelta) {
      reasoning += reasoningDelta;
      onReasoningDelta(reasoningDelta);
    }
  };

  const consumeLine = (line) => {
    if (line === '') {
      if (dataLines.length) consumeData(dataLines.join('\n'));
      dataLines = [];
      return;
    }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) consumeLine(line);
  }

  buffer += decoder.decode();
  if (buffer) consumeLine(buffer);
  if (dataLines.length) consumeData(dataLines.join('\n'));

  if (!completed) {
    throw new Error(
      'Streaming response ended before the provider sent [DONE] or a finish_reason. ' +
      'The partial response was discarded; retry the request.',
    );
  }

  const message = { content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  return { model, choices: [{ message, finish_reason: finishReason }], usage };
}

// Minimal "ping" request to verify the endpoint, API key, and model are all
// reachable. Throws on HTTP errors (same as callAPI); returns latency, the
// echoed model id, and a preview of the model's reply. Uses the same request
// body as a real call, so it validates the actual path a commit would take.
export async function checkConnection(config, stream = null) {
  const { apiUrl, apiKey, modelId, maxTokens, timeoutMs, extraBody, reasoning } = config;
  const t0 = performance.now();

  const data = await callAPI(
    apiUrl,
    apiKey,
    modelId,
    [{ role: 'user', content: 'Reply with exactly: OK' }],
    0,
    reasoning?.mode === 'on'
      ? Math.max(Math.min(maxTokens || 1024, 64), reasoning.maxTokens || 4096)
      : Math.min(maxTokens || 1024, 64),
    timeoutMs,
    extraBody,
    reasoning,
    stream,
  );

  const content = extractMessage(data);
  const reasoningContent = extractReasoning(data?.choices?.[0]?.message);

  return {
    elapsed: performance.now() - t0,
    model: data?.model || null,
    content: content.trim(),
    reasoning: reasoningContent,
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

// OpenAI-compatible providers use a few different values when the output
// budget is exhausted. Treat all known token-limit variants alike, while a
// normal `stop` (or a provider omitting finish_reason) remains untouched.
function hitTokenLimit(data) {
  const reason = data?.choices?.[0]?.finish_reason;
  return typeof reason === 'string' && /^(?:length|max_tokens|max_output_tokens)$/i.test(reason);
}

// A formatting follow-up does not need to repeat reasoning that has already
// happened. Disable it only for providers where we know the switch is valid;
// unknown compatible endpoints keep their configured behavior.
function reasoningForFollowUp(config) {
  const reasoning = config.reasoning;
  if (reasoning?.mode !== 'on') return reasoning;

  const host = endpointHost(config.apiUrl);
  if (
    host.includes('minimax')
    || host === 'api.deepseek.com'
    || host.endsWith('.deepseek.com')
    || host === 'openrouter.ai'
    || reasoning.disabledBody !== undefined
  ) {
    return { ...reasoning, mode: 'off' };
  }
  if (host === 'api.openai.com') {
    const supported = openAIReasoningEfforts(config.modelId);
    if (supported?.includes('none')) return { ...reasoning, mode: 'off' };
  }
  return reasoning;
}

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

// Prompt for a regenerate request: the model already saw the diff on the
// first call and produced a message for it, so the diff is NOT re-sent —
// rewording its own previous reply is enough, and far cheaper than resending
// what can be tens of thousands of tokens (same trade-off as correctivePrompt).
function regeneratePrompt(previousMessage) {
  return [
    'You previously generated this commit message for the change:',
    '',
    previousMessage.slice(0, 1000),
    '',
    'Generate a DIFFERENT commit message for the same change — different wording or emphasis. ' +
    'Keep the conventional commit format: first line "<type>: <subject>", ' +
    'then an optional body after a blank line. ' +
    'Output ONLY the new message — no explanation, no quotes, no code fences.',
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
function reasoningText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(reasoningText).filter(Boolean).join('\n');
  }
  if (value && typeof value === 'object') {
    return reasoningText(value.text ?? value.summary ?? value.content);
  }
  return '';
}

function extractReasoning(msg0) {
  return reasoningText(msg0?.reasoning_content)
    || reasoningText(msg0?.reasoning)
    || reasoningText(msg0?.reasoning_details)
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
    for (const key of ['prompt_tokens', 'completion_tokens', 'input_tokens', 'output_tokens', 'total_tokens']) {
      if (typeof u[key] === 'number') total[key] = (total[key] || 0) + u[key];
    }
  }
  return Object.keys(total).length ? total : null;
}

// Make the API call and return the assistant text plus reasoning accumulated
// across the initial and any follow-up response. Reasoning models that can't disable thinking (MiniMax M2.x,
// DeepSeek R1, OpenRouter reasoning models) may return empty content with a
// reasoning trace; in that case a follow-up call feeds the (truncated) tail of
// the reasoning back as context so the model produces the final answer — the
// original messages (which include the full diff) are NOT re-sent, since the
// reasoning tail already carries the model's own analysis of them.
// Shared by the commit flow and the split flow. `usage` aggregates the token
// counts of every call made in the round.
export async function getResponseText(config, messages, temperature, maxTokens, followUpPrompt, stream = null) {
  let data = await callAPI(
    config.apiUrl, config.apiKey, config.modelId, messages, temperature, maxTokens,
    config.timeoutMs, config.extraBody, config.reasoning, stream,
  );
  const usages = [data?.usage];
  let reasoning = extractReasoning(data?.choices?.[0]?.message);
  let text = extractMessage(data);
  const truncatedByLimit = hitTokenLimit(data);

  if ((!text.trim() && reasoning) || truncatedByLimit) {
    const truncated = (reasoning || '').length > MAX_REASONING_CHARS
      ? '…' + reasoning.slice(-MAX_REASONING_CHARS)
      : (reasoning || '');

    const partial = text.trim();
    const recoveryPrompt = truncatedByLimit
      ? 'The previous response was cut off by the provider token limit. ' +
        'Reproduce the COMPLETE answer from the beginning; do not continue from the cut-off point. ' +
        'Keep the answer concise.\n\n' + followUpPrompt
      : followUpPrompt;

    // With reasoning, its conclusion plus the partial answer is enough to
    // reconstruct the output without paying to send the original diff again.
    // A non-reasoning model has no such summary, so retain the original
    // messages for the rare case where its response itself hit the limit.
    const systemMsg = messages.find(m => m.role === 'system');
    const recoveryMessages = reasoning
      ? [
          ...(systemMsg ? [systemMsg] : []),
          {
            role: 'assistant',
            content: partial
              ? `${truncated}\n\nPartial response (discard and replace):\n${partial.slice(-MAX_REASONING_CHARS)}`
              : truncated,
          },
          { role: 'user', content: recoveryPrompt },
        ]
      : [
          ...messages,
          ...(partial ? [{ role: 'assistant', content: partial.slice(-MAX_REASONING_CHARS) }] : []),
          { role: 'user', content: recoveryPrompt },
        ];

    // A token-limit retry gets a larger ceiling. This is especially useful for
    // non-reasoning models, which need the original request again; reasoning
    // models instead reuse their analysis and avoid re-sending a large diff.
    const recoveryMaxTokens = truncatedByLimit
      ? Math.min(Math.max(maxTokens * 2, maxTokens + 1024), 16384)
      : maxTokens;
    data = await callAPI(
      config.apiUrl, config.apiKey, config.modelId, recoveryMessages,
      temperature, recoveryMaxTokens, config.timeoutMs, config.extraBody,
      reasoningForFollowUp(config), stream,
    );
    usages.push(data?.usage);
    const followUpReasoning = extractReasoning(data?.choices?.[0]?.message);
    if (followUpReasoning) {
      reasoning = [reasoning, followUpReasoning].filter(Boolean).join('\n\n');
    }
    text = extractMessage(data);
  }

  return { text, data, reasoning, usage: sumUsage(...usages) };
}

// `previousMessage` is the message from the last generation, when there is
// one. On regenerate it lets the model reword its own reply instead of
// re-reading the diff — the diff is only sent on the first attempt. Setting
// "regenerateWithDiff" in the config opts back into re-sending the diff on
// every attempt (more variety, much higher token cost).
export async function generateCommitMessage(
  config, diff, regenerateCount = 0, previousMessage = '', stream = null,
) {
  const { prompt, temperature, language, maxTokens, regenerateWithDiff, reasoning: reasoningConfig } = config;
  const t0 = performance.now();
  const outputTokenLimit = reasoningConfig?.mode === 'on'
    ? Math.max(maxTokens, reasoningConfig.maxTokens || 4096)
    : maxTokens;

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

  // On regenerate, raise the temperature to get a different result — and skip
  // the diff entirely: re-sending it on every regenerate would be the biggest
  // token cost of the whole flow, while the previous message already captures
  // the change. The model rewords its own reply instead (same cheap pattern
  // as the corrective retry). "regenerateWithDiff" opts back into the old
  // behavior: the full diff plus an attempt hint, for more varied rewrites.
  const variedTemperature = Math.min(temperature + regenerateCount * 0.15, 1.2);
  let userContent;
  if (regenerateCount > 0 && previousMessage && !regenerateWithDiff) {
    userContent = regeneratePrompt(previousMessage) + langReminder;
  } else {
    const variationHint = regenerateCount > 0
      ? `\n(Attempt #${regenerateCount + 1}: please produce a DIFFERENT commit message than before.)`
      : '';
    userContent = `Here is the git diff:\n\n\`\`\`diff\n${diff}\n\`\`\`` + variationHint + langReminder;
  }

  const messages = [
    { role: 'system', content: prompt + langHint },
    { role: 'user',    content: userContent },
  ];

  const { text, data, reasoning: initialReasoning, usage: firstUsage } = await getResponseText(
    config, messages, variedTemperature, outputTokenLimit, FOLLOWUP_COMMIT_PROMPT, stream,
  );
  let usage = firstUsage;
  let reasoning = initialReasoning;
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
      variedTemperature, outputTokenLimit, FOLLOWUP_COMMIT_PROMPT, stream,
    );
    const fixed = cleanCommitMessage(retry.text);
    // The retry is a real API call that cost tokens regardless of whether it
    // produced a usable message — count its usage unconditionally.
    usage = sumUsage(usage, retry.usage);
    if (retry.reasoning) {
      reasoning = [reasoning, retry.reasoning].filter(Boolean).join('\n\n');
    }
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
      `its token budget on reasoning (maxTokens: ${outputTokenLimit}).\n` +
      `  Try raising "maxTokens" in your config.\n\nRaw response:\n${snippet}`,
    );
  }

  return { message: cleanCommitMessage(message), elapsed, usage, reasoning };
}
