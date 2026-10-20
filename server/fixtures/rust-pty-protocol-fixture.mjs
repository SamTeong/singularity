import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const request = JSON.parse(line);
  const respond = (ok = true, extra = {}) => process.stdout.write(`${JSON.stringify({ type: 'response', id: request.id, generation: request.generation, ok, ...extra })}\n`);
  const event = (id, generation, name, extra = {}) => process.stdout.write(`${JSON.stringify({ type: 'event', event: name, id, generation, ...extra })}\n`);

  if (request.op === 'spawn' && request.bin === 'fail') {
    respond(false, { error: 'fixture spawn failure' });
    return;
  }
  if (request.op === 'spawn' && request.bin === 'early') {
    event(request.id, request.generation, 'output', { data_bytes: [226] });
    event(request.id, request.generation, 'output', { data_bytes: [130, 172] });
    event(request.id, request.generation, 'exit', { exitCode: 0 });
    respond();
    return;
  }
  if (request.op === 'spawn' && request.bin === 'final-exit') {
    respond();
    const padding = `${JSON.stringify({ type: 'noise', padding: 'x'.repeat(4 * 1024 * 1024) })}\n`;
    process.stdout.write(padding, () => {
      event(request.id, request.generation, 'output', { data_bytes: [226] });
      event(request.id, request.generation, 'output', { data_bytes: [130, 172] });
      event(request.id, request.generation, 'exit', { exitCode: 17 });
      process.exit(0);
    });
    return;
  }
  if (request.op === 'spawn' && request.bin === 'stdout-closes-first') {
    respond();
    process.stdout.end();
    setTimeout(() => process.exit(0), 50);
    return;
  }
  if (request.op === 'spawn') {
    if (request.generation > 1) event(request.id, request.generation - 1, 'output', { data_bytes: [...Buffer.from('stale')] });
    respond();
    return;
  }
  respond();
});
