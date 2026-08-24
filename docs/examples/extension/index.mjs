export function contextProvider({ files }) {
  const packages = [...new Set(files.map(({ path }) => path.split('/')[0]).filter(Boolean))];
  return { text: `Changed top-level areas: ${packages.join(', ')}`, warnings: [] };
}

export function messageValidator({ message }) {
  return {
    issues: /(?:ACME|ticket)-\d+/i.test(message)
      ? []
      : [{ severity: 'warning', code: 'ticket', message: 'consider including a ticket id' }],
  };
}

export function providerAdapter({ operation, config, request, response, reasoning }) {
  if (operation === 'buildRequest') {
    return {
      model: config.modelId,
      input: request.messages,
      max_output_tokens: request.maxTokens,
    };
  }
  if (operation === 'normalizeResponse') {
    return {
      content: response.output_text || '',
      model: response.model,
      usage: response.usage,
      finishReason: response.status,
    };
  }
  if (operation === 'reasoningForFollowUp') return { ...reasoning, mode: 'off' };
  throw new Error(`Unsupported providerAdapter operation: ${operation}`);
}
