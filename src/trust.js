const BEGIN = 'BEGIN_AICOMMIT_UNTRUSTED_JSON';
const END = 'END_AICOMMIT_UNTRUSTED_JSON';

export function encodeUntrustedData(kind, content) {
  if (typeof kind !== 'string' || !/^[a-z][a-z0-9_]*$/.test(kind)) {
    throw new Error('Untrusted data kind must be a lowercase identifier.');
  }
  return [
    BEGIN,
    JSON.stringify({ kind, untrusted: true, content: String(content ?? '') }),
    END,
  ].join('\n');
}

export function decodeUntrustedData(block) {
  const lines = String(block).split('\n');
  if (lines.length !== 3 || lines[0] !== BEGIN || lines[2] !== END) {
    throw new Error('Invalid untrusted data envelope.');
  }
  const value = JSON.parse(lines[1]);
  if (
    !value ||
    typeof value !== 'object' ||
    value.untrusted !== true ||
    typeof value.kind !== 'string' ||
    typeof value.content !== 'string'
  ) {
    throw new Error('Invalid untrusted data payload.');
  }
  return value;
}
