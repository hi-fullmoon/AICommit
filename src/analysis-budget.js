import { ERROR_CATEGORIES, fail } from './errors.js';

export const DEFAULT_LARGE_CHANGE = Object.freeze({
  strategy: 'auto',
  chunkInputTokens: 12000,
  maxTotalTokens: 200000,
  concurrency: 2,
  timeoutMs: 180000,
  cache: Object.freeze({
    enabled: true,
    ttlMs: 24 * 60 * 60 * 1000,
    maxBytes: 32 * 1024 * 1024,
    allowUnprotected: false,
  }),
});

export function estimateTokens(text) {
  // Deliberately conservative fallback for providers without a tokenizer.
  return Math.ceil(Buffer.byteLength(String(text), 'utf8') / 2);
}

export function createAnalysisBudget(settings = {}) {
  const limits = { ...DEFAULT_LARGE_CHANGE, ...settings };
  const started = Date.now();
  let charged = 0;
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reserveFinal = 0;
  return {
    limits,
    signal: AbortSignal.timeout(limits.timeoutMs),
    reserveFinal(tokens) {
      reserveFinal = tokens;
    },
    remainingMs() {
      return Math.max(0, limits.timeoutMs - (Date.now() - started));
    },
    snapshot() {
      return {
        requests,
        budgetedTokens: charged,
        maxTotalTokens: limits.maxTotalTokens,
        elapsedMs: Date.now() - started,
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      };
    },
    reserve(input, output) {
      const exhausted = !this.remainingMs()
        ? 'time'
        : requests >= 256
          ? 'requests'
          : charged + input + output + reserveFinal > limits.maxTotalTokens
            ? 'tokens'
            : null;
      if (exhausted) {
        throw fail(
          ERROR_CATEGORIES.PROVIDER,
          `Large-change analysis reached its ${exhausted} budget.`,
          { data: { analysis: { ...this.snapshot(), exhausted } } },
        );
      }
      if (input > limits.chunkInputTokens) {
        throw fail(
          ERROR_CATEGORIES.PROVIDER,
          'Analysis request exceeds largeChange.chunkInputTokens; shorten repository context or increase the personal input budget.',
          { data: { analysis: { ...this.snapshot(), exhausted: 'input' } } },
        );
      }
      charged += input + output;
      requests += 1;
      inputTokens += input;
      outputTokens += output;
      return { input, output };
    },
    settle(ticket, usage) {
      if (!ticket || !usage) return;
      const actualInput = usage.inputTokens ?? ticket.input;
      const actualOutput = usage.outputTokens ?? ticket.output;
      charged +=
        Math.max(usage.totalTokens || 0, actualInput + actualOutput) - ticket.input - ticket.output;
      inputTokens += actualInput - ticket.input;
      outputTokens += actualOutput - ticket.output;
    },
  };
}
