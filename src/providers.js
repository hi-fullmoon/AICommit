import modelCapabilities from './model-capabilities.json' with { type: 'json' };

function getSupportedThinkingLevels(model) {
  if (!model.reasoning) return ['off'];
  return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    return mapped !== null && (!['xhigh', 'max'].includes(level) || mapped !== undefined);
  });
}

function clampThinkingLevel(model, level) {
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const supported = getSupportedThinkingLevels(model);
  if (supported.includes(level)) return level;
  const index = levels.indexOf(level);
  return (
    levels.slice(index).find((candidate) => supported.includes(candidate)) ??
    levels
      .slice(0, index)
      .reverse()
      .find((candidate) => supported.includes(candidate)) ??
    'off'
  );
}
export const PROVIDER_TYPES = Object.freeze([
  'openai',
  'openrouter',
  'deepseek',
  'minimax',
  'ollama',
  'custom',
]);
export const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const DEFAULT_REASONING_EFFORT = 'medium';
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

// Read the local capability snapshot. Credentials and network model discovery remain
// outside this layer; a configured model ID need not be present in the catalog.
function catalogModel(provider, modelId) {
  const models = modelCapabilities.providers[provider];
  if (!models) return undefined;
  const id = Object.hasOwn(models, modelId)
    ? modelId
    : provider === 'openai'
      ? modelId.replace(/-codex$/, '')
      : modelId;
  return Object.hasOwn(models, id) ? modelCapabilities.profiles[models[id]] : undefined;
}

export function isOpenAIReasoningModel(modelId = '') {
  return catalogModel('openai', modelId)?.reasoning ?? /^(?:o\d|gpt-5)/i.test(modelId);
}

export function reasoningEffortsForModel(providerType, modelId) {
  const known = catalogModel((providerType || '').toLowerCase(), modelId);
  if (known?.reasoning) {
    const supported = getSupportedThinkingLevels(known);
    return REASONING_EFFORTS.filter((effort) => supported.includes(effort));
  }
  return [...REASONING_EFFORTS];
}

export function canDisableReasoningForModel(providerType, modelId) {
  const known = catalogModel((providerType || '').toLowerCase(), modelId);
  return !known || getSupportedThinkingLevels(known).includes('off');
}

function mergeRequestExtras(payload, extras) {
  if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return;
  const { model: _model, messages: _messages, stream: _stream, ...safe } = extras;
  Object.assign(payload, safe);
}

function resolveEffort(provider, model, reasoning) {
  if ((reasoning?.mode || 'auto') === 'auto' || !model.reasoning) return undefined;
  const requested = reasoning.mode === 'on' ? reasoning.effort || DEFAULT_REASONING_EFFORT : 'off';
  const known = catalogModel(provider, model.id);
  if (
    known &&
    ['openai', 'openrouter'].includes(provider) &&
    !getSupportedThinkingLevels(known).includes(requested)
  ) {
    throw new Error(
      `${provider === 'openai' ? 'OpenAI' : 'OpenRouter'} model "${model.id}" does not support ${requested === 'off' ? 'disabling reasoning' : `reasoning effort "${requested}"`}. ` +
        `Supported reasoning efforts: ${getSupportedThinkingLevels(known).join(', ')}.`,
    );
  }
  const level = known && provider === 'deepseek' ? clampThinkingLevel(known, requested) : requested;
  return level === 'off' ? undefined : level;
}

// Keep vendor parameter mappings separate from the OpenAI SDK transport.
export function getProviderAdapter({ apiUrl, providerType = '', modelId = '' }) {
  const provider = detectProviderType(apiUrl, providerType);
  const nativeOllama =
    provider === 'ollama' && /\/api\/(?:chat|generate)\/?$/i.test(endpoint(apiUrl)?.pathname || '');
  const known = catalogModel(provider, modelId);
  const openAIReasoning = provider === 'openai' && isOpenAIReasoningModel(modelId);
  const tokenField = openAIReasoning ? 'max_completion_tokens' : 'max_tokens';
  const model = {
    ...known,
    id: modelId,
    api: 'openai-completions',
    provider,
    // The transport pins the full configured URL, including nonstandard proxy paths.
    baseUrl: endpoint(apiUrl)?.origin || '',
    reasoning:
      known?.reasoning ?? (openAIReasoning || ['deepseek', 'openrouter'].includes(provider)),
    contextWindow: known?.contextWindow || 128000,
    maxTokens: known?.maxTokens || 16384,
  };
  const capabilities = Object.freeze({
    streaming: !nativeOllama,
    reasoning:
      provider === 'custom'
        ? 'configurable'
        : ['openai', 'openrouter', 'deepseek'].includes(provider) && !model.reasoning
          ? 'model-dependent'
          : 'native',
    tokenBudget: nativeOllama ? 'options.num_predict' : tokenField,
    usage: true,
    finishReason: true,
  });
  return Object.freeze({
    id: provider,
    model,
    nativeOllama,
    capabilities,
    headers: provider === 'openrouter' ? { 'X-Title': 'aicommit' } : {},
    options({ temperature, maxTokens, extraBody, reasoning }) {
      const mode = reasoning?.mode || 'auto';
      const reasoningEffort = resolveEffort(provider, model, reasoning);
      return {
        maxTokens,
        temperature:
          openAIReasoning || (provider === 'deepseek' && mode === 'on') ? undefined : temperature,
        reasoningEffort,
        onPayload(payload) {
          // Auto preserves server defaults; explicit modes take precedence over extras.
          const reasoningKeys = ['thinking', 'reasoning', 'reasoning_effort'];
          const mapped = Object.fromEntries(
            reasoningKeys
              .filter((key) => payload[key] !== undefined)
              .map((key) => [key, payload[key]]),
          );
          if (mode === 'auto') for (const key of reasoningKeys) delete payload[key];
          mergeRequestExtras(payload, extraBody);
          if (mode !== 'auto') {
            if (model.reasoning) {
              for (const key of reasoningKeys) delete payload[key];
              Object.assign(payload, mapped);
              if (provider === 'openai' && mode === 'off')
                payload.reasoning_effort = model.thinkingLevelMap?.off || 'none';
            }
            if (provider === 'deepseek') {
              delete payload.enable_thinking;
              if (mode === 'on') delete payload.temperature;
            } else if (provider === 'minimax') {
              payload.reasoning_split = true;
              delete payload.enable_thinking;
              if (mode === 'off') payload.thinking = { type: 'disabled' };
              else delete payload.thinking;
            } else if (nativeOllama) {
              payload.think = mode === 'on';
            } else if (provider === 'custom' || provider === 'ollama') {
              mergeRequestExtras(
                payload,
                mode === 'on' ? reasoning?.enabledBody : reasoning?.disabledBody,
              );
            }
          }
          if (provider === 'openai') {
            payload.stream_options = { ...payload.stream_options, include_usage: true };
          }
          payload.stream = true;
        },
      };
    },
    reasoningForFollowUp(reasoning) {
      if (reasoning?.mode !== 'on') return reasoning;
      if (provider !== 'custom' && canDisableReasoningForModel(provider, modelId))
        return { ...reasoning, mode: 'off' };
      if (reasoning.disabledBody !== undefined) return { ...reasoning, mode: 'off' };
      return reasoning;
    },
  });
}
