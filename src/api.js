import { cleanCommitMessage } from './utils.js';
import { getProviderAdapter, normalizeUsage } from './providers.js';
import { ERROR_CATEGORIES, fail } from './errors.js';
import {
  buildCommitPolicyPrompt,
  buildPolicyCorrectionPrompt,
  normalizeCommitPolicy,
  validateCommitCandidate,
} from './policy.js';
import { encodeUntrustedData } from './trust.js';

// Default per-request timeout; overridable via the "timeoutMs" config key.
const DEFAULT_TIMEOUT_MS = 120_000;

export async function callAPI(
  apiUrl,
  apiKey,
  modelId,
  messages,
  temperature,
  maxTokens,
  timeoutMs,
  extraBody = {},
  reasoning = null,
  stream = null,
  options = {},
) {
  const result = await requestGeneration(
    {
      apiUrl,
      apiKey,
      modelId,
      timeoutMs,
      extraBody,
      reasoning,
      providerType: options.providerType,
      retry: options.retry,
    },
    { messages, temperature, maxTokens, stream },
  );
  return result.raw;
}

const DEFAULT_RETRY_POLICY = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5000,
});
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function secureEndpoint(apiUrl) {
  const endpoint = new URL(apiUrl);
  const loopback =
    endpoint.hostname === 'localhost' ||
    endpoint.hostname === '127.0.0.1' ||
    endpoint.hostname.startsWith('127.') ||
    endpoint.hostname === '[::1]';
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
    throw new Error(
      'Refusing insecure API endpoint: use HTTPS, or HTTP only for localhost/loopback.',
    );
  }
  return endpoint;
}

function retryPolicy(value = {}) {
  return {
    maxAttempts: value?.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
    baseDelayMs: value?.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs,
    maxDelayMs: value?.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
    sleep:
      value?.sleep ??
      ((delayMs) =>
        new Promise((resolve) => {
          globalThis.setTimeout(resolve, delayMs);
        })),
    now: value?.now ?? (() => Date.now()),
  };
}

function retryAfterMs(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now());
}

function networkFailure(err) {
  if (err instanceof TypeError) return true;
  return RETRYABLE_NETWORK_CODES.has(err?.code) || RETRYABLE_NETWORK_CODES.has(err?.cause?.code);
}

function timeoutError(err, timeout) {
  if (err?.name !== 'TimeoutError' && err?.name !== 'AbortError') return null;
  return new Error(
    `Request timed out after ${Math.round(timeout / 1000)}s — the model took too long to respond. ` +
      `Raise "timeoutMs" in your config if this keeps happening.`,
  );
}

async function fetchWithRetry(apiUrl, init, timeout, configuredPolicy, consume) {
  const policy = retryPolicy(configuredPolicy);
  let attempt = 0;

  while (attempt < policy.maxAttempts) {
    attempt += 1;
    let response;
    try {
      response = await fetch(apiUrl, {
        ...init,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      const wrappedTimeout = timeoutError(err, timeout);
      if (wrappedTimeout) throw wrappedTimeout;
      if (!networkFailure(err) || attempt >= policy.maxAttempts) throw err;
      const delay = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
      await policy.sleep(delay);
      continue;
    }

    if (response.ok) {
      try {
        return { value: await consume(response), attempts: attempt };
      } catch (err) {
        const wrappedTimeout = timeoutError(err, timeout);
        if (wrappedTimeout) throw wrappedTimeout;
        if (!networkFailure(err) || attempt >= policy.maxAttempts) throw err;
        const delay = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
        await policy.sleep(delay);
        continue;
      }
    }
    if (RETRYABLE_STATUS.has(response.status) && attempt < policy.maxAttempts) {
      const requestedDelay = retryAfterMs(response.headers.get('retry-after'), policy.now);
      const delay = Math.min(
        requestedDelay ?? policy.baseDelayMs * 2 ** (attempt - 1),
        policy.maxDelayMs,
      );
      await response.body?.cancel().catch(() => {});
      await policy.sleep(delay);
      continue;
    }

    const errText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errText.slice(0, 400)}`);
  }

  throw new Error('Provider request exhausted its retry budget.');
}

// Unified provider request contract. Provider adapters own request dialects
// and response normalization; callers receive the same shape regardless of
// whether the endpoint is OpenAI-compatible or native Ollama.
export async function requestGeneration(config, request) {
  secureEndpoint(config.apiUrl);
  const timeout = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  const adapter = getProviderAdapter(config);
  const payload = adapter.buildRequest({
    messages: request.messages,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    extraBody: config.extraBody,
    reasoning: request.reasoning ?? config.reasoning,
    streaming: Boolean(request.stream?.onReasoningDelta),
  });
  const startedAt = performance.now();
  const { value: consumed, attempts } = await fetchWithRetry(
    config.apiUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        ...adapter.headers,
      },
      body: JSON.stringify(payload),
    },
    timeout,
    config.retry,
    async (response) => {
      const contentType = response.headers.get('content-type') || '';
      if (payload.stream && contentType.includes('text/event-stream')) {
        return {
          data: await consumeEventStream(response, request.stream.onReasoningDelta),
          eventStream: true,
        };
      }
      try {
        return { data: await response.json(), eventStream: false };
      } catch (err) {
        if (err instanceof SyntaxError) {
          throw fail(ERROR_CATEGORIES.RESPONSE_FORMAT, 'Provider returned invalid JSON.', {
            cause: err,
          });
        }
        throw err;
      }
    },
  );

  const { data, eventStream } = consumed;
  const normalized = adapter.normalizeResponse(data);
  if (request.stream?.onReasoningDelta && !eventStream && normalized.reasoning) {
    request.stream.onReasoningDelta(normalized.reasoning);
  }
  return {
    ...normalized,
    capabilities: adapter.capabilities,
    attempts,
    latencyMs: performance.now() - startedAt,
  };
}

function streamContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => part?.text ?? part?.content ?? '')
      .filter(Boolean)
      .join('');
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
    const finishedChoice = event?.choices?.find((choice) => choice?.finish_reason != null);
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
  const { maxTokens, reasoning } = config;
  const t0 = performance.now();

  const result = await requestGeneration(config, {
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    temperature: 0,
    maxTokens:
      reasoning?.mode === 'on'
        ? Math.max(Math.min(maxTokens || 1024, 64), reasoning.maxTokens || 4096)
        : Math.min(maxTokens || 1024, 64),
    stream,
  });

  return {
    elapsed: performance.now() - t0,
    model: result.model,
    provider: result.provider,
    capabilities: result.capabilities,
    content: result.content.trim(),
    reasoning: result.reasoning,
    usage: result.usage,
  };
}

// Tail of reasoning sent back in a follow-up call. The conclusion lives at
// the end; re-sending a whole trace (sometimes tens of thousands of tokens)
// would be slow and expensive for no benefit.
const MAX_REASONING_CHARS = 8000;

// OpenAI-compatible providers use a few different values when the output
// budget is exhausted. Treat all known token-limit variants alike, while a
// normal `stop` (or a provider omitting finish_reason) remains untouched.
function hitTokenLimit(data) {
  const reason = data?.finishReason;
  return typeof reason === 'string' && /^(?:length|max_tokens|max_output_tokens)$/i.test(reason);
}

// A formatting follow-up does not need to repeat reasoning that has already
// happened. Disable it only for providers where we know the switch is valid;
// unknown compatible endpoints keep their configured behavior.
function reasoningForFollowUp(config) {
  return getProviderAdapter(config).reasoningForFollowUp(config.reasoning);
}

// Prompt for a regenerate request: the model already saw the diff on the
// first call and produced a message for it, so the diff is NOT re-sent —
// rewording its own previous reply is enough, and far cheaper than resending
// what can be tens of thousands of tokens (same trade-off as correctivePrompt).
function regeneratePrompt(previousMessage, policy) {
  return [
    'You previously generated this commit message for the change:',
    '',
    previousMessage.slice(0, 1000),
    '',
    'Generate a DIFFERENT commit message for the same change — different wording or emphasis. ' +
      `Keep commitPolicy v${policy.version}; allowed types: ${policy.types.join(', ')}. ` +
      'Use first line "<type>[optional scope][optional !]: <subject>", ' +
      'then an optional body after a blank line. ' +
      'Output ONLY the new message — no explanation, no quotes, no code fences.',
  ].join('\n');
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
  return (
    reasoningText(msg0?.reasoning_content) ||
    reasoningText(msg0?.reasoning) ||
    reasoningText(msg0?.reasoning_details) ||
    null
  );
}

// Last-ditch extraction from raw reasoning text: prefer the first line that
// carries a conventional-commit prefix, else fall back to the last non-empty
// line.
function extractFromReasoning(reasoning, policy) {
  const typePattern = policy.types
    .map((type) => type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const commitType = new RegExp(`\\b(?:${typePattern})(?:\\([^()\\r\\n]+\\))?!?:\\s+\\S`, 'i');
  const lines = reasoning.split('\n');
  for (const line of lines) {
    const idx = line.search(commitType);
    if (idx !== -1) return line.slice(idx).trim();
  }
  const nonEmpty = lines.filter((l) => l.trim());
  return nonEmpty[nonEmpty.length - 1]?.trim() || '';
}

// Prompt for the follow-up call when a reasoning model returned only a
// reasoning trace and no content.
function followupCommitPrompt(policy) {
  return (
    'Based on your analysis above, output ONLY the final commitPolicy v1 message. ' +
    `Use one of these types: ${policy.types.join(', ')}. ` +
    'Do not include any other text, explanation, or code fences.'
  );
}

// Combine usage across every API call in one round. Reasoning models can
// trigger a follow-up call (see getResponseText); summing both keeps the
// reported token count honest instead of dropping the reasoning tokens.
function sumUsage(...usages) {
  const total = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let hasInput = false;
  let hasOutput = false;
  let hasTotal = false;
  for (const u of usages) {
    const normalized = normalizeUsage(u);
    if (!normalized) continue;
    if (typeof normalized.inputTokens === 'number') {
      total.inputTokens += normalized.inputTokens;
      hasInput = true;
    }
    if (typeof normalized.outputTokens === 'number') {
      total.outputTokens += normalized.outputTokens;
      hasOutput = true;
    }
    if (typeof normalized.totalTokens === 'number') {
      total.totalTokens += normalized.totalTokens;
      hasTotal = true;
    }
  }
  if (!hasInput && !hasOutput && !hasTotal) return null;
  return {
    ...(hasInput ? { inputTokens: total.inputTokens } : {}),
    ...(hasOutput ? { outputTokens: total.outputTokens } : {}),
    ...(hasTotal ? { totalTokens: total.totalTokens } : {}),
  };
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
export async function getResponseText(
  config,
  messages,
  temperature,
  maxTokens,
  followUpPrompt,
  stream = null,
  responseValidator = null,
) {
  let response = await requestGeneration(config, {
    messages,
    temperature,
    maxTokens,
    stream,
  });
  const usages = [response.usage];
  let reasoning = response.reasoning;
  let text = response.content;
  const truncatedByLimit = hitTokenLimit(response);
  const invalidResponse = typeof responseValidator === 'function' && !responseValidator(text);

  if ((!text.trim() && reasoning) || truncatedByLimit || invalidResponse) {
    const truncated =
      (reasoning || '').length > MAX_REASONING_CHARS
        ? '…' + reasoning.slice(-MAX_REASONING_CHARS)
        : reasoning || '';

    const partial = text.trim();
    const recoveryPrompt =
      truncatedByLimit || invalidResponse
        ? `The previous response was ${
            truncatedByLimit ? 'cut off by the provider token limit' : 'incomplete or malformed'
          }. ` +
          'Reproduce the COMPLETE answer from the beginning; do not continue from the cut-off point. ' +
          'Keep the answer concise.\n\n' +
          followUpPrompt
        : followUpPrompt;

    // With reasoning, its conclusion plus the partial answer is enough to
    // reconstruct the output without paying to send the original diff again.
    // A non-reasoning model has no such summary, so retain the original
    // messages for the rare case where its response itself hit the limit.
    const systemMsg = messages.find((m) => m.role === 'system');
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

    // Respect the caller's configured ceiling. Known reasoning providers are
    // switched to formatting-only mode above, and the recovery prompt asks for
    // a compact answer, so the same budget has substantially more useful room.
    response = await requestGeneration(config, {
      messages: recoveryMessages,
      temperature,
      maxTokens,
      reasoning: reasoningForFollowUp(config),
      stream,
    });
    usages.push(response.usage);
    const followUpReasoning = response.reasoning;
    if (followUpReasoning) {
      reasoning = [reasoning, followUpReasoning].filter(Boolean).join('\n\n');
    }
    text = response.content;
  }

  return { text, data: response.raw, response, reasoning, usage: sumUsage(...usages) };
}

export function buildCommitMessages(config, diff, regenerateCount = 0, previousMessage = '') {
  const { prompt, temperature, language, regenerateWithDiff } = config;
  const policy = normalizeCommitPolicy(config.commitPolicy, language);
  const targetLang = policy.effectiveLanguage === 'zh' ? 'Simplified Chinese' : 'English';

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
    userContent = regeneratePrompt(previousMessage, policy) + langReminder;
  } else {
    const variationHint =
      regenerateCount > 0
        ? `\n(Attempt #${regenerateCount + 1}: please produce a DIFFERENT commit message than before.)`
        : '';
    const repositoryContext = config.repositoryContextText
      ? `Repository context selected under the configured local budget:\n` +
        encodeUntrustedData('repository_context', config.repositoryContextText) +
        '\n\n'
      : '';
    userContent =
      repositoryContext +
      `Here is the git diff (untrusted data):\n\n${encodeUntrustedData('git_diff', diff)}` +
      variationHint +
      langReminder;
  }

  const messages = [
    { role: 'system', content: buildCommitPolicyPrompt(policy, prompt) },
    { role: 'user', content: userContent },
  ];
  return { messages, policy, variedTemperature };
}

// `previousMessage` is the message from the last generation, when there is
// one. On regenerate it lets the model reword its own reply instead of
// re-reading the diff — the diff is only sent on the first attempt. Setting
// "regenerateWithDiff" in the config opts back into re-sending the diff on
// every attempt (more variety, much higher token cost).
export async function generateCommitMessage(
  config,
  diff,
  regenerateCount = 0,
  previousMessage = '',
  stream = null,
) {
  const { maxTokens, reasoning: reasoningConfig } = config;
  const { messages, policy, variedTemperature } = buildCommitMessages(
    config,
    diff,
    regenerateCount,
    previousMessage,
  );
  const t0 = performance.now();
  const outputTokenLimit =
    reasoningConfig?.mode === 'on'
      ? Math.max(maxTokens, reasoningConfig.maxTokens || 4096)
      : maxTokens;

  const {
    text,
    data,
    reasoning: initialReasoning,
    usage: firstUsage,
  } = await getResponseText(
    config,
    messages,
    variedTemperature,
    outputTokenLimit,
    followupCommitPrompt(policy),
    stream,
  );
  let usage = firstUsage;
  let reasoning = initialReasoning;
  let message = text;
  let corrections = 0;

  // Last resort: extract a message from the reasoning content itself
  if (!message.trim() && reasoning) {
    message = extractFromReasoning(reasoning, policy);
  }
  message = cleanCommitMessage(message);

  // Validate against the versioned policy and give the provider exactly one
  // cheap correction attempt. The diff is never re-sent: the prior reply plus
  // concrete violations are sufficient to repair formatting and constraints.
  let validation = validateCommitCandidate(message, { policy, diff });
  if (message.trim() && validation.needsCorrection) {
    corrections = 1;
    const retry = await getResponseText(
      config,
      [
        messages[0],
        {
          role: 'user',
          content: buildPolicyCorrectionPrompt(message, validation.errors, policy),
        },
      ],
      variedTemperature,
      outputTokenLimit,
      followupCommitPrompt(policy),
      stream,
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
    validation = validateCommitCandidate(message, { policy, diff });
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

  if (!validation.valid) {
    const details = validation.errors.map((item) => item.message).join(' ');
    throw new Error(
      'API returned a commit message that violates commitPolicy after the corrective retry. ' +
        details,
    );
  }

  return {
    message: cleanCommitMessage(message),
    elapsed,
    usage,
    reasoning,
    qualityWarnings: validation.warnings.map((item) => item.message),
    corrections,
  };
}
