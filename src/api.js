import { cleanCommitMessage } from './utils.js';
import { getProviderAdapter, normalizeUsage } from './providers.js';
import { requestGeneration } from './model-client.js';
export { requestGeneration } from './model-client.js';
import { ERROR_CATEGORIES, fail } from './errors.js';
import {
  buildCommitPolicyPrompt,
  buildPolicyCorrectionPrompt,
  normalizeCommitPolicy,
  validateCommitCandidate,
} from './policy.js';
import { encodeUntrustedData } from './trust.js';
import { estimateTokens } from './analysis-budget.js';

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
  return (
    typeof reason === 'string' &&
    /^(?:length|max_tokens|max_output_tokens|token_limit)$/i.test(reason)
  );
}

// A formatting follow-up does not need to repeat reasoning that has already
// happened. Disable it only for providers where we know the switch is valid;
// unknown compatible endpoints keep their configured behavior.
async function reasoningForFollowUp(config) {
  const adapter = getProviderAdapter(config);
  return adapter.reasoningForFollowUp(config.reasoning);
}

// Each generation is stateless. Keep bounded evidence from the same protected
// snapshot so a rewrite can correct an earlier misunderstanding.
function regenerationEvidence(diff, maxChars = 6000) {
  const chars = Array.from(diff);
  if (chars.length <= maxChars) return diff;
  const marker = '\n... (middle omitted; these excerpts are incomplete evidence) ...\n';
  const available = Math.max(0, maxChars - marker.length);
  const tail = Math.floor(available / 3);
  return (
    chars.slice(0, available - tail).join('') + marker + (tail ? chars.slice(-tail).join('') : '')
  );
}

function regeneratePrompt(previousMessage, policy, evidence) {
  return [
    'Reassess the change using these bounded excerpts from the original protected input. ' +
      'They may be incomplete. Correct omissions or mistakes in the previous message; do not infer unsupported behavior.',
    encodeUntrustedData('change_evidence', evidence),
    'You previously generated this commit message for the change:',
    '',
    encodeUntrustedData('previous_message', previousMessage.slice(0, 1000)),
    '',
    'Generate a DIFFERENT commit message for the same change — different wording or emphasis. ' +
      `Keep commitPolicy v${policy.version}; allowed types: ${policy.types.join(', ')}. ` +
      'Use first line "<type>[optional scope][optional !]: <subject>", ' +
      'then an optional body after a blank line. ' +
      'Output ONLY the new message — no explanation, no quotes, no code fences.',
  ].join('\n');
}

export function assertCompleteResponse(response, usage = null, latencyMs = null) {
  if (hitTokenLimit(response)) {
    throw fail(
      ERROR_CATEGORIES.RESPONSE_FORMAT,
      'Provider response was still truncated after recovery. Increase maxTokens or edit the partial message manually.',
      {
        code: 'response_truncated',
        data: { partialMessage: response.content, usage, latencyMs },
      },
    );
  }
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
  const started = performance.now();
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
    const followUp = typeof followUpPrompt === 'function' ? followUpPrompt() : followUpPrompt;
    const recoveryPrompt =
      truncatedByLimit || invalidResponse
        ? `The previous response was ${
            truncatedByLimit ? 'cut off by the provider token limit' : 'incomplete or malformed'
          }. ` +
          'Reproduce the COMPLETE answer from the beginning; do not continue from the cut-off point. ' +
          'Keep the answer concise.\n\n' +
          followUp
        : followUp;

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
      reasoning: await reasoningForFollowUp(config),
      stream,
    });
    usages.push(response.usage);
    const followUpReasoning = response.reasoning;
    if (followUpReasoning) {
      reasoning = [reasoning, followUpReasoning].filter(Boolean).join('\n\n');
    }
    text = response.content;
  }

  const usage = sumUsage(...usages);
  assertCompleteResponse(response, usage, performance.now() - started);
  return { text, data: response.raw, response, reasoning, usage };
}

export function buildCommitMessages(config, diff, regenerateCount = 0, previousMessage = '') {
  const { prompt, temperature, language, regenerateWithDiff } = config;
  const policy = normalizeCommitPolicy(config.commitPolicy, language);
  const targetLang = policy.effectiveLanguage === 'zh' ? 'Simplified Chinese' : 'English';

  // Weak models weigh the end of the request most, so repeat the language
  // constraint after the diff where it can't be drowned out by the prompt.
  const langReminder = `\n\n(Remember: the commit message must be in ${targetLang}.)`;

  // Default rewrites use bounded evidence; explicit opt-in retains the full input.
  const variedTemperature = Math.min(temperature + regenerateCount * 0.15, 1.2);
  let userContent;
  if (regenerateCount > 0 && previousMessage && !regenerateWithDiff) {
    const inputLimit =
      config.analysisBudget?.limits.chunkInputTokens || config.largeChange?.chunkInputTokens;
    let fits = false;
    for (let cap = 6000; cap >= 128; cap = Math.floor(cap / 2)) {
      userContent =
        regeneratePrompt(previousMessage, policy, regenerationEvidence(diff, cap)) + langReminder;
      const inputTokens = estimateTokens(
        JSON.stringify([
          { role: 'system', content: buildCommitPolicyPrompt(policy, prompt) },
          { role: 'user', content: userContent },
        ]),
      );
      if (!inputLimit || inputTokens <= inputLimit) {
        fits = true;
        break;
      }
    }
    if (!fits) {
      throw fail(
        ERROR_CATEGORIES.CONFIG,
        'Regeneration evidence and commit policy do not fit largeChange.chunkInputTokens; increase the input budget or shorten custom guidance.',
      );
    }
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
      (regenerateCount > 0 && previousMessage
        ? '\n\nPrevious message to improve:\n' +
          encodeUntrustedData('previous_message', previousMessage.slice(0, 1000))
        : '') +
      variationHint +
      langReminder;
  }

  const messages = [
    { role: 'system', content: buildCommitPolicyPrompt(policy, prompt) },
    { role: 'user', content: userContent },
  ];
  return { messages, policy, variedTemperature };
}

// Reuse bounded evidence from the captured input on rewrites. Setting
// regenerateWithDiff opts into sending the full input each time.
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
  const validate = (candidate) => validateCommitCandidate(candidate, { policy, diff });

  let validation = await validate(message);
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
    ).catch((error) => {
      if (error.code === 'response_truncated') {
        error.data.usage = sumUsage(usage, error.data.usage);
        error.data.latencyMs = performance.now() - t0;
        error.data.corrections = corrections;
      }
      throw error;
    });
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
    validation = await validate(message);
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
    throw fail(
      ERROR_CATEGORIES.RESPONSE_FORMAT,
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
