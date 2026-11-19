import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
// Generations whose exit must wait until a newer generation of the same id spawns.
const deferredExits = [];
input.on('line', (line) => {
  const request = JSON.parse(line);
  const respond = (ok = true, extra = {}) => process.stdout.write(`${JSON.stringify({ type: 'response', id: request.id, generation: request.generation, ok, ...extra })}\n`);
  const event = (id, generation, name, extra = {}) => process.stdout.write(`${JSON.stringify({ type: 'event', event: name, id, generation, ...extra })}\n`);

  if (request.op === 'kill') {
    if (process.env.PTY_KILL_LOG) appendFileSync(process.env.PTY_KILL_LOG, `${request.generation}\n`);
    respond();
    return;
  }
  if (request.op === 'spawn' && request.bin === 'defer-exit') {
    deferredExits.push({ id: request.id, generation: request.generation });
    respond();
    return;
  }
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
    // Flush older generations' deferred exits before accepting this spawn, so
    // the adapter has processed a superseded exit by the time spawn() resolves.
    for (let i = 0; i < deferredExits.length; i++) {
      if (deferredExits[i].id === request.id && deferredExits[i].generation !== request.generation) {
        event(deferredExits[i].id, deferredExits[i].generation, 'exit', { exitCode: 0 });
        deferredExits.splice(i--, 1);
      }
    }
    if (request.generation > 1) event(request.id, request.generation - 1, 'output', { data_bytes: [...Buffer.from('stale')] });
    respond();
    return;
  }
  respond();
});
