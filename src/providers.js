export const PROVIDER_TYPES = Object.freeze([
  'openai',
  'openrouter',
  'deepseek',
  'minimax',
  'ollama',
  'custom',
]);
const PROVIDER_TYPE_SET = new Set(PROVIDER_TYPES);

export function isProviderType(value) {
  return typeof value === 'string' && PROVIDER_TYPE_SET.has(value.toLowerCase());
}

function endpoint(apiUrl) {
  try {
    return new URL(apiUrl);
  } catch {
    return null;
  }
}

export function detectProviderType(apiUrl, explicitType = '') {
  if (explicitType) {
    const normalized = explicitType.toLowerCase();
    if (!PROVIDER_TYPE_SET.has(normalized)) {
      throw new Error(
        `Unknown providerType "${explicitType}". Use one of: ${PROVIDER_TYPES.join(', ')}.`,
      );
    }
    return normalized;
  }

  const url = endpoint(apiUrl);
  const host = url?.hostname.toLowerCase() || '';
  if (host === 'api.openai.com') return 'openai';
  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return 'openrouter';
  if (host === 'api.deepseek.com' || host.endsWith('.deepseek.com')) return 'deepseek';
  if (host.includes('minimax')) return 'minimax';
  if (
    /\/api\/(?:chat|generate)\/?$/i.test(url?.pathname || '') &&
    (host === 'localhost' || host.startsWith('127.') || host === '[::1]')
  ) {
    return 'ollama';
  }
  return 'custom';
}

export function isOpenAIReasoningModel(modelId) {
  const id = (modelId || '').split('/').pop();
  return /^(?:o\d|gpt-5)/i.test(id);
}

function openAIReasoningEfforts(modelId) {
  const id = (modelId || '').split('/').pop().toLowerCase();
  if (/^gpt-5\.6(?:-|$)/.test(id)) return ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (/^gpt-5\.(?:2|3|4|5)(?:-|$)/.test(id)) {
    return ['none', 'low', 'medium', 'high', 'xhigh'];
  }
  if (/^gpt-5\.1(?:-|$)/.test(id)) return ['none', 'low', 'medium', 'high'];
  if (/^gpt-5(?:-|$)/.test(id) || /^o\d(?:-|$)/.test(id)) return ['low', 'medium', 'high'];
  return null;
}

function openAIReasoningEffort(modelId, enabled, effort) {
  const requested = enabled ? effort : 'none';
  const supported = openAIReasoningEfforts(modelId);
  if (!supported || supported.includes(requested)) return requested;

  const action = enabled ? `reasoning effort "${requested}"` : 'disabling reasoning';
  throw new Error(
    `OpenAI model "${modelId}" does not support ${action}. ` +
      `Supported reasoning efforts: ${supported.join(', ')}.`,
  );
}

function mergeRequestExtras(payload, extras) {
  if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return;
  const { model: _model, messages: _messages, ...safe } = extras;
  Object.assign(payload, safe);
}

function reasoningText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(reasoningText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    return reasoningText(value.text ?? value.summary ?? value.content);
  }
  return '';
}

function messageText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => part?.text ?? part?.content ?? '')
      .filter(Boolean)
      .join('');
  }
  return value?.text ?? value?.content ?? '';
}

function firstNumber(...values) {
  return values.find((value) => typeof value === 'number' && Number.isFinite(value));
}

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;

  const inputTokens = firstNumber(
    usage.inputTokens,
    usage.prompt_tokens,
    usage.input_tokens,
    usage.prompt_eval_count,
  );
  const outputTokens = firstNumber(
    usage.outputTokens,
    usage.completion_tokens,
    usage.output_tokens,
    usage.eval_count,
  );
  const totalTokens = firstNumber(
    usage.totalTokens,
    usage.total_tokens,
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined,
  );

  const normalized = {};
  if (inputTokens !== undefined) normalized.inputTokens = inputTokens;
  if (outputTokens !== undefined) normalized.outputTokens = outputTokens;
  if (totalTokens !== undefined) normalized.totalTokens = totalTokens;
  return Object.keys(normalized).length ? normalized : null;
}

function normalizeResponse(provider, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Provider returned an invalid response: expected a JSON object.');
  }

  const choice = data?.choices?.[0];
  const message = choice?.message ?? data.message;
  const content =
    messageText(message?.content) ||
    messageText(data?.content?.[0]?.text) ||
    messageText(data.response);
  const reasoning =
    reasoningText(message?.reasoning_content) ||
    reasoningText(message?.reasoning) ||
    reasoningText(message?.reasoning_details) ||
    reasoningText(message?.thinking) ||
    reasoningText(data.thinking) ||
    null;
  const finishReason =
    choice?.finish_reason ?? data.stop_reason ?? data.done_reason ?? (data.done ? 'stop' : null);
  const usageSource =
    data.usage ||
    (data.prompt_eval_count !== undefined || data.eval_count !== undefined
      ? {
          prompt_eval_count: data.prompt_eval_count,
          eval_count: data.eval_count,
        }
      : null);

  return {
    provider,
    model: data.model || null,
    content,
    reasoning,
    usage: normalizeUsage(usageSource),
    finishReason,
    raw: data,
  };
}

function applyReasoning(payload, provider, modelId, reasoning, nativeOllama) {
  const mode = reasoning?.mode || 'auto';
  if (mode === 'auto') return;

  const enabled = mode === 'on';
  const effort = reasoning?.effort || 'medium';

  if (provider === 'openai') {
    if (!isOpenAIReasoningModel(modelId)) return;
    payload.reasoning_effort = openAIReasoningEffort(modelId, enabled, effort);
    return;
  }

  if (provider === 'deepseek') {
    delete payload.enable_thinking;
    payload.thinking = { type: enabled ? 'enabled' : 'disabled' };
    if (enabled) {
      payload.reasoning_effort = effort === 'low' || effort === 'max' ? effort : 'high';
      delete payload.temperature;
    } else {
      delete payload.reasoning_effort;
    }
    return;
  }

  if (provider === 'openrouter') {
    payload.reasoning = { effort: enabled ? effort : 'none' };
    return;
  }

  if (provider === 'minimax') {
    payload.reasoning_split = true;
    if (enabled) {
      delete payload.thinking;
      delete payload.enable_thinking;
    } else {
      delete payload.enable_thinking;
      payload.thinking = { type: 'disabled' };
    }
    return;
  }

  if (provider === 'ollama' && nativeOllama) {
    payload.think = enabled;
    return;
  }

  const customBody = enabled ? reasoning?.enabledBody : reasoning?.disabledBody;
  if (customBody !== undefined) mergeRequestExtras(payload, customBody);
}

function reasoningForFollowUp(provider, modelId, reasoning) {
  if (reasoning?.mode !== 'on') return reasoning;
  if (['deepseek', 'openrouter', 'minimax', 'ollama'].includes(provider)) {
    return { ...reasoning, mode: 'off' };
  }
  if (provider === 'openai') {
    const supported = openAIReasoningEfforts(modelId);
    if (supported?.includes('none')) return { ...reasoning, mode: 'off' };
  }
  if (reasoning.disabledBody !== undefined) return { ...reasoning, mode: 'off' };
  return reasoning;
}

export function getProviderAdapter({ apiUrl, providerType = '', modelId = '' }) {
  const provider = detectProviderType(apiUrl, providerType);
  const url = endpoint(apiUrl);
  const nativeOllama =
    provider === 'ollama' && /\/api\/(?:chat|generate)\/?$/i.test(url?.pathname || '');
  const openAIReasoning = provider === 'openai' && isOpenAIReasoningModel(modelId);

  const capabilities = Object.freeze({
    streaming: !nativeOllama,
    reasoning:
      provider === 'custom'
        ? 'configurable'
        : provider === 'openai' && !openAIReasoning
          ? 'model-dependent'
          : 'native',
    tokenBudget: nativeOllama
      ? 'options.num_predict'
      : openAIReasoning
        ? 'max_completion_tokens'
        : 'max_tokens',
    usage: true,
    finishReason: true,
  });

  return Object.freeze({
    id: provider,
    capabilities,
    headers: provider === 'openrouter' ? { 'X-Title': 'aicommit' } : {},
    buildRequest({ messages, temperature, maxTokens, extraBody = {}, reasoning, streaming }) {
      const payload = { model: modelId, messages };
      if (nativeOllama) {
        // Ollama's native stream is newline-delimited JSON rather than SSE.
        // Use its complete JSON response until the request layer exposes an
        // NDJSON consumer; reasoning still reaches the callback once parsed.
        payload.stream = false;
        payload.options = { temperature, num_predict: maxTokens };
      } else if (openAIReasoning) {
        payload.max_completion_tokens = maxTokens;
      } else {
        payload.temperature = temperature;
        payload.max_tokens = maxTokens;
      }

      mergeRequestExtras(payload, extraBody);
      applyReasoning(payload, provider, modelId, reasoning, nativeOllama);
      if (streaming && !nativeOllama) {
        payload.stream = true;
        if (provider === 'openai') {
          const current = payload.stream_options;
          payload.stream_options = {
            ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
            include_usage: true,
          };
        }
      }
      return payload;
    },
    normalizeResponse(data) {
      return normalizeResponse(provider, data);
    },
    reasoningForFollowUp(reasoning) {
      return reasoningForFollowUp(provider, modelId, reasoning);
    },
  });
}
