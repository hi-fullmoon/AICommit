import { cleanCommitMessage } from './utils.js';

export async function callAPI(apiUrl, apiKey, modelId, messages, temperature, maxTokens) {
  const body = JSON.stringify({
    model: modelId,
    messages,
    temperature,
    max_tokens: maxTokens,
    enable_thinking: false,
  });

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errText.slice(0, 400)}`);
  }

  return response.json();
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
  let message = data?.choices?.[0]?.message?.content;
  const reasoning = data?.choices?.[0]?.message?.reasoning_content;

  // Fallback: try Anthropic-style response format (content[0].text)
  if (!message && message !== '') {
    message = data?.content?.[0]?.text;
  }

  // When content is empty but reasoning_content exists (common with DeepSeek
  // reasoning models), make a follow-up call using the reasoning as context
  // to extract the final commit message.
  if (!message && reasoning) {
    const followUpMessages = [
      ...messages,
      { role: 'assistant', content: reasoning },
      {
        role: 'user',
        content:
          'Based on your analysis above, output ONLY the final conventional commit message ' +
          '(e.g. feat:, fix:, chore:, docs:, refactor:, test:, style:, perf:, ci:, build:). ' +
          'Do not include any other text, explanation, or code fences.',
      },
    ];

    data = await callAPI(apiUrl, apiKey, modelId, followUpMessages, variedTemperature, maxTokens);
    message = data?.choices?.[0]?.message?.content;
  }

  // Last resort: extract a message from the reasoning content itself
  if (!message && reasoning) {
    // Try to find a conventional commit line in the reasoning
    const match = reasoning.match(/(?:^|\n)((?:feat|fix|chore|docs|refactor|test|style|perf|ci|build)[\w]*[!:]\s*.+?)(?:\n|$)/i);
    if (match) {
      message = match[1].trim();
    } else {
      // Take the last non-empty line of reasoning as a fallback
      const lines = reasoning.split('\n').filter(l => l.trim());
      message = lines[lines.length - 1]?.trim() || reasoning.slice(0, 200).trim();
    }
  }

  const elapsed = performance.now() - t0;

  if (!message) {
    const snippet = JSON.stringify(data, null, 2).slice(0, 600);
    throw new Error(
      !data?.choices?.[0]?.message?.content && data?.choices?.[0]?.message?.content === ''
        ? `API returned an empty commit message.\n  Hint: the model produced reasoning but returned empty content.\n  Try setting "temperature" to a higher value in your config.\n\nRaw response:\n${snippet}`
        : `Unexpected API response shape — got:\n\n${snippet}\n\n` +
          `Expected OpenAI format (choices[0].message.content) or ` +
          `Anthropic format (content[0].text).`,
    );
  }

  return { message: cleanCommitMessage(message), elapsed, usage: data?.usage };
}
