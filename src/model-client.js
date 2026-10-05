import OpenAI from 'openai';
import { getProviderAdapter, normalizeUsage } from './providers.js';
import { ERROR_CATEGORIES, fail } from './errors.js';
import { completionEvent, normalizeEventStream } from './provider-response.js';
import { estimateTokens } from './analysis-budget.js';

const DEFAULT_TIMEOUT_MS = 120_000;

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

async function fetchWithRetry(
  apiUrl,
  init,
  timeout,
  configuredPolicy,
  consume,
  beforeAttempt = null,
) {
  const policy = retryPolicy(configuredPolicy);
  let attempt = 0;

  while (attempt < policy.maxAttempts) {
    attempt += 1;
    beforeAttempt?.();
    let response;
    try {
      response = await fetch(apiUrl, {
        ...init,
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)])
          : AbortSignal.timeout(timeout),
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
        // Once the provider has accepted a generation request, replaying it is
        // unsafe: the first request may already have completed and been billed
        // even though its response body was interrupted locally.
        throw err;
      }
    }
    if (RETRYABLE_STATUS.has(response.status) && attempt < policy.maxAttempts) {
      const requestedDelay = retryAfterMs(response.headers.get('retry-after'), policy.now);
      if (requestedDelay !== null && requestedDelay > policy.maxDelayMs) {
        await response.body?.cancel().catch(() => {});
        throw new Error(
          `HTTP ${response.status}: provider requested a retry after ${Math.ceil(
            requestedDelay / 1000,
          )}s, exceeding the configured retry.maxDelayMs limit.`,
        );
      }
      const delay =
        requestedDelay ?? Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
      await response.body?.cancel().catch(() => {});
      await policy.sleep(delay);
      continue;
    }

    const errText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errText.slice(0, 400)}`);
  }

  throw new Error('Provider request exhausted its retry budget.');
}

function nativeOllamaPayload(payload, apiUrl) {
  const { max_tokens, temperature, stream_options: _streamOptions, options, ...rest } = payload;
  const body = {
    ...rest,
    stream: false,
    options: { temperature, num_predict: max_tokens, ...options },
  };
  if (/\/api\/generate\/?$/i.test(new URL(apiUrl).pathname)) {
    // /generate accepts a prompt, not the messages array used by /chat.
    body.system = body.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    body.prompt = body.messages
      .filter((m) => m.role !== 'system')
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n\n');
    delete body.messages;
  }
  return body;
}

function transport(config, adapter, state) {
  return async (_sdkUrl, init) => {
    try {
      const headers = new globalThis.Headers(init.headers);
      // Never let SDK defaults resolve a different credential or follow a redirect
      // carrying repository content to an endpoint the user did not configure.
      if (config.apiKey) headers.set('Authorization', `Bearer ${config.apiKey}`);
      else headers.delete('Authorization');
      let payload = JSON.parse(init.body);
      if (adapter.nativeOllama) payload = nativeOllamaPayload(payload, config.apiUrl);
      else if (config.extraBody?.stream === false) {
        payload.stream = false;
        delete payload.stream_options;
      }
      const result = await fetchWithRetry(
        config.apiUrl,
        {
          ...init,
          headers,
          body: JSON.stringify(payload),
          redirect: 'error',
        },
        config.timeoutMs || DEFAULT_TIMEOUT_MS,
        config.analysisBudget
          ? {
              ...config.retry,
              sleep: async (ms) => {
                if (ms >= config.analysisBudget.remainingMs())
                  throw new Error('Analysis timed out during retry backoff.');
                await new Promise((resolve) => {
                  setTimeout(resolve, ms);
                });
              },
            }
          : config.retry,
        async (response) => {
          if (
            (response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream')
          )
            return normalizeEventStream(response, adapter.id);
          let data;
          try {
            data = await response.json();
          } catch (err) {
            if (err instanceof SyntaxError)
              throw fail(ERROR_CATEGORIES.RESPONSE_FORMAT, 'Provider returned invalid JSON.', {
                cause: err,
              });
            throw err;
          }
          const event = completionEvent(data);
          state.raw = data;
          return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        },
        config.analysisBudget
          ? () => {
              state.ticket = config.analysisBudget.reserve(
                config.analysisInputTokens,
                config.analysisOutputTokens,
              );
            }
          : null,
      );
      state.attempts = result.attempts;
      return result.value;
    } catch (err) {
      state.error = err;
      throw err;
    }
  };
}

function requestPayload(adapter, request, options) {
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const messages = request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      if (!['user', 'assistant'].includes(message.role))
        throw new Error(`Unsupported generation message role: ${message.role}`);
      return {
        role: message.role,
        content: message.content,
        ...((adapter.id === 'deepseek' ||
          adapter.model.requiresReasoningContentOnAssistantMessages) &&
        adapter.model.reasoning &&
        message.role === 'assistant'
          ? { reasoning_content: '' }
          : {}),
      };
    });
  if (system) messages.unshift({ role: 'system', content: system });
  const payload = {
    model: adapter.model.id,
    messages,
    stream: true,
    [adapter.capabilities.tokenBudget === 'max_completion_tokens'
      ? 'max_completion_tokens'
      : 'max_tokens']: options.maxTokens,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  };
  const model = adapter.model;
  const effort = options.reasoningEffort;
  const mapped = model.thinkingLevelMap?.[effort] ?? effort;
  if (model.reasoning) {
    if (adapter.id === 'deepseek') {
      if (effort) payload.thinking = { type: 'enabled' };
      else if (model.thinkingLevelMap?.off !== null) payload.thinking = { type: 'disabled' };
      if (effort) payload.reasoning_effort = mapped;
    } else if (adapter.id === 'openrouter') {
      if (effort) payload.reasoning = { effort: mapped };
      else if (model.thinkingLevelMap?.off !== null)
        payload.reasoning = { effort: model.thinkingLevelMap?.off ?? 'none' };
    } else if (adapter.id === 'openai') {
      if (effort) payload.reasoning_effort = mapped;
      else if (typeof model.thinkingLevelMap?.off === 'string')
        payload.reasoning_effort = model.thinkingLevelMap.off;
    }
  }
  options.onPayload(payload);
  return payload;
}

function generationError(err, state, config) {
  if (err.category) return err;
  const cause = state.error || err;
  if (cause.category) return cause;
  const timeout = timeoutError(cause, config.timeoutMs || DEFAULT_TIMEOUT_MS);
  if (timeout || /timed out|timeout/i.test(cause.message))
    return fail(ERROR_CATEGORIES.NETWORK, timeout?.message || cause.message, { cause });
  if (networkFailure(cause) || /socket|network|fetch failed|terminated|econn/i.test(cause.message))
    return fail(ERROR_CATEGORIES.NETWORK, cause.message, { cause });
  if (cause instanceof SyntaxError)
    return fail(
      ERROR_CATEGORIES.RESPONSE_FORMAT,
      `Provider returned invalid JSON: ${cause.message}`,
      { cause },
    );
  return cause;
}

export async function requestGeneration(config, request) {
  secureEndpoint(config.apiUrl);
  if (config.analysisBudget) {
    config = {
      ...config,
      analysisInputTokens: estimateTokens(JSON.stringify(request.messages)),
      analysisOutputTokens: request.maxTokens,
      timeoutMs: Math.max(
        1,
        Math.min(config.timeoutMs || DEFAULT_TIMEOUT_MS, config.analysisBudget.remainingMs()),
      ),
    };
  }
  const adapter = getProviderAdapter(config);
  const options = adapter.options({
    ...request,
    extraBody: config.extraBody,
    reasoning: request.reasoning ?? config.reasoning,
  });
  const state = { attempts: 0, raw: null, error: null };
  const startedAt = performance.now();
  const controller = new AbortController();
  // An explicit key prevents SDK environment credential discovery. The transport
  // removes this placeholder and sends only the resolved AICommit credential.
  const client = new OpenAI({
    apiKey: config.apiKey || 'aicommit-keyless',
    baseURL: adapter.model.baseUrl,
    defaultHeaders: adapter.headers,
    maxRetries: 0,
    timeout: config.timeoutMs || DEFAULT_TIMEOUT_MS,
    fetch: transport(config, adapter, state),
  });
  let content = '';
  let reasoningText = '';
  let responseModel = config.modelId;
  let reportedUsage = null;
  let finishReason = null;
  try {
    const events = await client.chat.completions.create(requestPayload(adapter, request, options), {
      signal: config.analysisBudget
        ? AbortSignal.any([controller.signal, config.analysisBudget.signal])
        : controller.signal,
    });
    for await (const event of events) {
      if (event.model) responseModel = event.model;
      if (event.usage) reportedUsage = event.usage;
      const choice = event.choices?.find((value) => (value.index ?? 0) === 0);
      if (!choice) continue;
      if (!event.usage && choice.usage) reportedUsage = choice.usage;
      const delta = choice.delta;
      if (typeof delta?.content === 'string') content += delta.content;
      if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
        reasoningText += delta.reasoning_content;
        request.stream?.onReasoningDelta?.(delta.reasoning_content);
      }
      if (choice.finish_reason != null) {
        finishReason = choice.finish_reason;
        if (!['stop', 'end', 'length', 'tool_calls', 'function_call'].includes(finishReason))
          throw fail(ERROR_CATEGORIES.PROVIDER, `Provider finish_reason: ${finishReason}`);
      }
    }
    // The SDK treats an AbortError as the end of iteration. An interrupted
    // response must still fail, even if a finish marker arrived before it.
    if (events.controller.signal.aborted)
      throw fail(ERROR_CATEGORIES.NETWORK, 'Provider response stream was aborted.');
    if (finishReason === null)
      throw fail(
        ERROR_CATEGORIES.RESPONSE_FORMAT,
        'Streaming response ended before the provider sent a finish_reason. The partial response was discarded; retry the request.',
      );
  } catch (err) {
    throw generationError(err, state, config);
  } finally {
    controller.abort();
  }
  const usage = state.raw
    ? normalizeUsage(state.raw.usage || state.raw.choices?.[0]?.usage || state.raw)
    : normalizeUsage(reportedUsage);
  const reasoning = reasoningText || null;
  const cacheRead =
    reportedUsage?.prompt_tokens_details?.cached_tokens ??
    reportedUsage?.prompt_cache_hit_tokens ??
    reportedUsage?.cached_tokens ??
    0;
  const cacheWrite = reportedUsage?.prompt_tokens_details?.cache_write_tokens || 0;
  const blocks = [];
  if (content) blocks.push({ type: 'text', text: content });
  if (reasoning) blocks.push({ type: 'thinking', thinking: reasoning });
  // Retain the previous public result shape for callers during the SDK migration.
  const assistantMessage = {
    role: 'assistant',
    api: 'openai-completions',
    provider: adapter.id,
    model: config.modelId,
    responseModel,
    content: blocks,
    usage: {
      input: Math.max(0, (usage?.inputTokens || 0) - cacheRead - cacheWrite),
      output: usage?.outputTokens || 0,
      cacheRead,
      cacheWrite,
      totalTokens: usage?.totalTokens || 0,
    },
    stopReason: ['tool_calls', 'function_call'].includes(finishReason)
      ? 'toolUse'
      : finishReason === 'end'
        ? 'stop'
        : finishReason,
    timestamp: Date.now(),
  };
  config.analysisBudget?.settle(state.ticket, usage);
  return {
    provider: adapter.id,
    model: responseModel,
    content,
    reasoning,
    usage,
    finishReason:
      state.raw?.choices?.[0]?.finish_reason ??
      state.raw?.stop_reason ??
      state.raw?.done_reason ??
      finishReason,
    raw: state.raw || {
      model: responseModel,
      choices: [
        { message: { content, reasoning_content: reasoning }, finish_reason: finishReason },
      ],
      usage: usage
        ? {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.totalTokens,
          }
        : null,
    },
    piMessage: assistantMessage,
    capabilities: adapter.capabilities,
    attempts: state.attempts,
    latencyMs: performance.now() - startedAt,
  };
}
