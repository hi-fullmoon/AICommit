import { readFile } from 'node:fs/promises';

const MAX_INPUT_CHARS = 256_000;

for (const method of ['log', 'info', 'warn', 'error']) {
  console[method] = (...values) => {
    process.stderr.write(`${values.map((value) => String(value)).join(' ')}\n`);
  };
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > MAX_INPUT_CHARS) throw new Error('Extension input exceeds 256000 characters.');
}

try {
  const request = JSON.parse(input);
  const source = await readFile(request.entry, 'utf8');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const extension = await import(moduleUrl);
  const handler = extension[request.capability];
  if (typeof handler !== 'function') {
    throw new Error(`Extension does not export ${request.capability}().`);
  }
  const result = await handler(request.input);
  write({ ok: true, result });
} catch (error) {
  write({ ok: false, error: String(error?.message || error).slice(0, 2000) });
  process.exitCode = 1;
}
