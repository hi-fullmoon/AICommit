import { EventSourceParserStream } from 'eventsource-parser/stream';
import { normalizeUsage } from './providers.js';
import { ERROR_CATEGORIES, fail } from './errors.js';

function textValue(value, separator = '\n') {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value
      .map((part) => textValue(part, separator))
      .filter(Boolean)
      .join(separator);
  if (value && typeof value === 'object')
    return textValue(value.text ?? value.summary ?? value.content, separator);
  return '';
}

// Some compatible endpoints ignore stream=true; native Ollama uses complete
// JSON here as before. Convert that single response into one SDK-readable event.
// The event normalizer below uses the same field mappings for real SSE responses.
export function completionEvent(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw fail(
      ERROR_CATEGORIES.RESPONSE_FORMAT,
      'Provider returned an invalid response: expected a JSON object.',
    );
  }
  if (data.error)
    throw fail(
      ERROR_CATEGORIES.PROVIDER,
      `Provider request failed: ${textValue(data.error.message) || JSON.stringify(data.error)}`,
    );
  const choice = data.choices?.[0];
  const message = choice?.message ?? data.message;
  const usage = normalizeUsage(data.usage || data);
  const finish = choice?.finish_reason ?? data.stop_reason ?? data.done_reason ?? 'stop';
  return {
    model: data.model,
    choices: [
      {
        index: 0,
        delta: {
          content:
            textValue(message?.content, '') ||
            textValue(data.content, '') ||
            textValue(data.response, ''),
          reasoning_content: reasoningDelta(message) || textValue(data.thinking),
        },
        finish_reason: normalizeFinishReason(finish),
      },
    ],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.totalTokens,
          },
        }
      : {}),
  };
}

// Keep provider stop aliases out of Pi's error branch so the business recovery
// path receives a truncated result. Unknown and safety-related reasons stay intact.
function normalizeFinishReason(reason) {
  if (['max_tokens', 'max_output_tokens', 'token_limit'].includes(reason)) return 'length';
  return reason === 'end_turn' ? 'stop' : reason;
}

function detailText(value) {
  if (Array.isArray(value)) return value.map(detailText).filter(Boolean).join('\n');
  if (value?.type === 'reasoning.encrypted') return '';
  return textValue(value);
}

function reasoningDelta(delta) {
  if (!delta) return '';
  const primary =
    textValue(delta.reasoning_content) ||
    textValue(delta.reasoning) ||
    textValue(delta.reasoning_text) ||
    textValue(delta.thinking);
  const details = detailText(delta.reasoning_details);
  // Providers sometimes expose the same delta in both representations. Only
  // deduplicate within this event: repeated text in a later delta can be intentional.
  if (!primary) return details;
  if (!details || primary.startsWith(details)) return primary;
  if (details.startsWith(primary)) return details;
  return primary + details;
}

function normalizeChunk(value) {
  if (!value || !Array.isArray(value.choices)) return value;
  for (const choice of value.choices) {
    if (!choice || typeof choice !== 'object') continue;
    choice.finish_reason = normalizeFinishReason(choice.finish_reason);
    const delta = choice.delta ?? choice.message;
    if (!delta || typeof delta !== 'object') continue;
    choice.delta = { ...delta, reasoning_content: reasoningDelta(delta) };
    // Retain reasoning_details for Pi's replay metadata while also exposing all
    // its textual segments as ordinary thinking deltas, including legacy shapes.
  }
  return value;
}

// eventsource-parser handles UTF-8-decoded SSE framing; this boundary adjusts
// only vendor fields. Pi still owns model-result assembly and finish validation.
// Web Stream piping preserves backpressure, cancellation and body read errors.
export function normalizeEventStream(response) {
  if (!response.body)
    throw fail(ERROR_CATEGORIES.RESPONSE_FORMAT, 'Streaming response did not include a body.');
  let done = false;
  const encoder = new globalThis.TextEncoder();
  const body = response.body
    .pipeThrough(new globalThis.TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
    .pipeThrough(
      new globalThis.TransformStream({
        transform(event, controller) {
          if (done) return;
          let data = event.data.trim();
          if (data === '[DONE]') {
            done = true;
          } else {
            let value;
            try {
              value = JSON.parse(data);
            } catch (cause) {
              throw fail(
                ERROR_CATEGORIES.RESPONSE_FORMAT,
                'Provider returned invalid JSON in streaming response.',
                { cause },
              );
            }
            data = JSON.stringify(normalizeChunk(value));
          }
          controller.enqueue(
            encoder.encode(`${event.event ? `event: ${event.event}\n` : ''}data: ${data}\n\n`),
          );
        },
      }),
    );
  const headers = new globalThis.Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'text/event-stream');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
