import { stream as streamPi } from '@earendil-works/pi-ai/api/openai-completions';
import { getProviderAdapter, normalizeUsage } from './providers.js';
import { ERROR_CATEGORIES, fail } from './errors.js';
import { completionEvent, normalizeEventStream } from './provider-response.js';

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

async function fetchWithRetry(apiUrl, init, timeout, configuredPolicy, consume) {
  const policy = retryPolicy(configuredPolicy);
  let attempt = 0;

  while (attempt < policy.maxAttempts) {
    attempt += 1;
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

function piContext(messages, model) {
  return {
    systemPrompt:
      messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n') || undefined,
    messages: messages
      .filter((m) => m.role !== 'system')
      .map((message) => {
        if (message.role === 'user') return { ...message, timestamp: Date.now() };
        if (message.role !== 'assistant')
          throw new Error(`Unsupported generation message role: ${message.role}`);
        return {
          role: 'assistant',
          content: [{ type: 'text', text: message.content }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: 'stop',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: Date.now(),
        };
      }),
  };
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
        config.retry,
        async (response) => {
          if (
            (response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream')
          )
            return normalizeEventStream(response);
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
      );
      state.attempts = result.attempts;
      return result.value;
    } catch (err) {
      state.error = err;
      throw err;
    }
  };
}

export async function requestGeneration(config, request) {
  secureEndpoint(config.apiUrl);
  const adapter = getProviderAdapter(config);
  const options = adapter.options({
    ...request,
    extraBody: config.extraBody,
    reasoning: request.reasoning ?? config.reasoning,
  });
  const state = { attempts: 0, raw: null, error: null };
  const startedAt = performance.now();
  const controller = new AbortController();
  const events = streamPi(adapter.model, piContext(request.messages, adapter.model), {
    ...options,
    // Pi's transport requires a key even for a keyless server. The placeholder
    // never leaves the process: transport installs only the resolved config key.
    apiKey: config.apiKey || 'aicommit-keyless',
    headers: adapter.headers,
    env: {},
    maxRetries: 0,
    timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS,
    signal: controller.signal,
    fetch: transport(config, adapter, state),
  });
  let result;
  try {
    for await (const event of events) {
      if (event.type === 'thinking_delta') request.stream?.onReasoningDelta?.(event.delta);
      if (event.type === 'error') {
        if (state.error) throw state.error;
        const message = event.error.errorMessage || 'Provider request failed.';
        if (/without finish_reason/.test(message))
          throw fail(
            ERROR_CATEGORIES.RESPONSE_FORMAT,
            'Streaming response ended before the provider sent a finish_reason. The partial response was discarded; retry the request.',
          );
        if (/timed out|timeout/i.test(message))
          throw fail(
            ERROR_CATEGORIES.NETWORK,
            `Request timed out after ${Math.round((config.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s — the model took too long to respond. Raise "timeoutMs" in your config if this keeps happening.`,
          );
        if (/socket|network|fetch failed|terminated|econn/i.test(message))
          throw fail(ERROR_CATEGORIES.NETWORK, message);
        if (/JSON|Unexpected token/i.test(message))
          throw fail(
            ERROR_CATEGORIES.RESPONSE_FORMAT,
            `Provider returned invalid JSON: ${message}`,
          );
        throw fail(ERROR_CATEGORIES.PROVIDER, `Provider request failed: ${message}`);
      }
      if (event.type === 'done') result = event.message;
    }
  } finally {
    controller.abort();
  }
  if (!result)
    throw fail(
      ERROR_CATEGORIES.RESPONSE_FORMAT,
      'Provider returned an invalid response: no completed generation.',
    );
  const content = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  const reasoning =
    result.content
      .filter((block) => block.type === 'thinking')
      .map((block) => block.thinking)
      .filter(Boolean)
      .join('\n') || null;
  const usage = state.raw
    ? normalizeUsage(state.raw.usage || state.raw)
    : result.usage.totalTokens ||
        result.usage.input ||
        result.usage.output ||
        result.usage.cacheRead ||
        result.usage.cacheWrite
      ? {
          inputTokens: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite,
          outputTokens: result.usage.output,
          totalTokens: result.usage.totalTokens,
        }
      : null;
  const finishReason =
    state.raw?.choices?.[0]?.finish_reason ??
    state.raw?.stop_reason ??
    state.raw?.done_reason ??
    result.rawStopReason ??
    result.stopReason;
  return {
    provider: adapter.id,
    model: result.responseModel || result.model,
    content,
    reasoning,
    usage,
    finishReason,
    // Preserve callAPI's Chat Completions-shaped compatibility return. Pi's full
    // normalized message is also available for future protocol-specific callers.
    raw: state.raw || {
      model: result.responseModel || result.model,
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
    piMessage: result,
    capabilities: adapter.capabilities,
    attempts: state.attempts,
    latencyMs: performance.now() - startedAt,
  };
}
