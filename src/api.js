import { cleanCommitMessage } from './utils.js';

export async function callAPI(apiUrl, apiKey, modelId, messages, temperature, maxTokens) {
  const body = JSON.stringify({
    model: modelId,
    messages,
    temperature,
    max_tokens: maxTokens,
    // Disable thinking across vendors; unknown params are ignored by
    // APIs that don't support them:
    // - enable_thinking: Qwen-style switch
    // - thinking.type=disabled: MiniMax OpenAI-compatible API (M3)
    // - reasoning_split: MiniMax M2.x can't disable thinking, but this moves
    //   the reasoning out of `content` into `reasoning_details`
    enable_thinking: false,
    thinking: { type: 'disabled' },
    reasoning_split: true,
  });

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      // Identify the app to OpenRouter (ignored by other providers).
      'X-Title': 'aicommit',
    },
    body,
  });

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
  const { apiUrl, apiKey, modelId, maxTokens } = config;
  const t0 = performance.now();

  const data = await callAPI(
    apiUrl,
    apiKey,
    modelId,
    [{ role: 'user', content: 'Reply with exactly: OK' }],
    0,
    Math.min(maxTokens || 1024, 64),
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

export async function generateCommitMessage(config, diff, regenerateCount = 0) {
  const { apiUrl, apiKey, modelId, prompt, temperature, language, maxTokens } = config;
  const t0 = performance.now();

  // Build language directive — prepended AND appended so it takes priority
  // even when the user's custom prompt contains conflicting language instructions.
  const langHintPre = language === 'zh'
    ? 'IMPORTANT: You MUST write the commit message in Chinese (Simplified Chinese).\n\n'
    : 'IMPORTANT: You MUST write the commit message in English.\n\n';
  const langHintPost = language === 'zh'
    ? '\n\nIMPORTANT: The commit message MUST be written in Chinese (Simplified Chinese).'
    : '\n\nIMPORTANT: The commit message MUST be written in English.';

  // On regenerate, vary the prompt and temperature to get a different result
  const variationHint = regenerateCount > 0
    ? `\n(Attempt #${regenerateCount + 1}: please produce a DIFFERENT commit message than before.)`
    : '';
  const variedTemperature = Math.min(temperature + regenerateCount * 0.15, 1.2);

  const messages = [
    { role: 'system', content: langHintPre + prompt + langHintPost },
    { role: 'user',    content: `Here is the git diff:\n\n\`\`\`diff\n${diff}\n\`\`\`` + variationHint },
  ];

  let data = await callAPI(apiUrl, apiKey, modelId, messages, variedTemperature, maxTokens);
  let message = extractMessage(data);
  const reasoning = extractReasoning(data?.choices?.[0]?.message);

  // When content is empty but reasoning exists (models that can't disable
  // thinking — MiniMax M2.x, DeepSeek R1, OpenRouter reasoning models),
  // make a follow-up call using the reasoning as context to extract the
  // final commit message. Only the tail of the reasoning is sent back — it
  // holds the conclusion, and a full trace would be slow and expensive.
  if (!message.trim() && reasoning) {
    const truncated = reasoning.length > MAX_REASONING_CHARS
      ? '…' + reasoning.slice(-MAX_REASONING_CHARS)
      : reasoning;

    const followUpMessages = [
      ...messages,
      { role: 'assistant', content: truncated },
      {
        role: 'user',
        content:
          'Based on your analysis above, output ONLY the final conventional commit message ' +
          '(e.g. feat:, fix:, chore:, docs:, refactor:, test:, style:, perf:, ci:, build:). ' +
          'Do not include any other text, explanation, or code fences.',
      },
    ];

    data = await callAPI(apiUrl, apiKey, modelId, followUpMessages, variedTemperature, maxTokens);
    message = extractMessage(data);
  }

  // Last resort: extract a message from the reasoning content itself
  if (!message.trim() && reasoning) {
    message = extractFromReasoning(reasoning);
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

  return { message: cleanCommitMessage(message), elapsed, usage: data?.usage };
}
