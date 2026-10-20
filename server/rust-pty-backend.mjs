import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createInterface } from 'node:readline';

const generationKey = (id, generation) => `${id}\u0000${generation}`;

export function createRustPtyBackend({ executable, args = ['--pty'], cwd, env = process.env, logger = console, stopTimeoutMs = 5000 }) {
  let child;
  let startPromise;
  let stopped = false;
  const generations = new Map();
  const latestGeneration = new Map();
  const counters = new Map();
  const responses = [];
  const sessions = new Set();

  function start() {
    if (stopped) return Promise.reject(new Error('PTY backend is stopped'));
    if (startPromise) return startPromise;
    startPromise = new Promise((resolve, reject) => {
      child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.once('spawn', resolve);
      child.once('error', reject);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (text) => logger.error?.(`[rust-pty] ${text.trimEnd()}`));
      let finalized = false;
      const finalizeServiceExit = (code, signal) => {
        if (finalized) return;
        finalized = true;
        stopped = true;
        const error = new Error(`PTY service exited (${signal ?? code})`);
        while (responses.length) responses.shift().reject(error);
        for (const session of sessions) session.serviceExit(code);
        sessions.clear();
      };
      child.once('close', finalizeServiceExit);
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => receive(line));
    });
    return startPromise;
  }

  function send(request) {
    return start().then(() => new Promise((resolve, reject) => {
      responses.push({ resolve, reject });
      const line = `${JSON.stringify(request)}\n`;
      child.stdin.write(line, (error) => {
        if (error) {
          const index = responses.findIndex((entry) => entry.resolve === resolve);
          if (index >= 0) responses.splice(index, 1);
          reject(error);
        }
      });
    }));
  }

  function receive(line) {
    let frame;
    try { frame = JSON.parse(line); } catch (error) {
      logger.error?.(`[rust-pty] invalid JSON frame: ${error.message}`);
      return;
    }
    if (frame.type === 'event') {
      const session = generations.get(generationKey(frame.id, frame.generation));
      if (session && latestGeneration.get(frame.id) === frame.generation) session.receive(frame);
      return;
    }
    if (frame.type !== 'response') {
      logger.error?.(`[rust-pty] unknown frame type: ${String(frame.type)}`);
      return;
    }
    const pending = responses.shift();
    if (!pending) {
      logger.error?.('[rust-pty] response received without a pending request');
      return;
    }
    if (frame.ok) pending.resolve(frame);
    else pending.reject(Object.assign(new Error(frame.error || 'PTY request failed'), { frame }));
  }

  function makeHandle(id, generation, previousGeneration) {
    const buffered = [];
    const decoder = new StringDecoder('utf8');
    let onData;
    let onExit;
    let active = false;
    let exited = false;
    const key = generationKey(id, generation);

    const handle = {
      id,
      generation,
      onData(callback) { onData = callback; return handle; },
      onExit(callback) { onExit = callback; return handle; },
      activate() {
        if (!onData || !onExit) throw new Error('PTY handlers must be wired before activation');
        active = true;
        while (buffered.length) dispatch(buffered.shift());
        return handle;
      },
      write(text) { return send({ op: 'write', id, generation, data_bytes: [...Buffer.from(String(text), 'utf8')] }); },
      resize(cols, rows) { return send({ op: 'resize', id, generation, cols, rows }); },
      kill() { return send({ op: 'kill', id, generation }); },
      receive(frame) {
        if (!active) { buffered.push(frame); return; }
        dispatch(frame);
      },
      serviceExit(code) {
        if (exited) return;
        const tail = decoder.end();
        if (tail && active) onData?.(tail);
        if (active && onExit) onExit(code, null);
        else buffered.push({ type: 'event', event: 'exit', exitCode: code, serviceExit: true });
        exited = true;
        generations.delete(key);
        sessions.delete(handle);
      },
    };

    function dispatch(frame) {
      if (frame.event === 'output') {
        const text = decoder.write(Buffer.from(frame.data_bytes ?? []));
        if (text) onData(text);
      } else if (frame.event === 'exit') {
        const tail = decoder.end();
        if (tail) onData(tail);
        onExit(frame.exitCode ?? null, null);
        exited = true;
        generations.delete(key);
        sessions.delete(handle);
      }
    }

    generations.set(key, handle);
    latestGeneration.set(id, generation);
    sessions.add(handle);
    handle.previousGeneration = previousGeneration;
    return handle;
  }

  async function spawnPty({ id, bin, args: spawnArgs, cwd: spawnCwd, env: spawnEnv, cols = 80, rows = 24 }) {
    const previousGeneration = latestGeneration.get(id);
    const generation = (counters.get(id) ?? 0) + 1;
    counters.set(id, generation);
    const handle = makeHandle(id, generation, previousGeneration);
    try {
      await send({ op: 'spawn', id, generation, bin, args: spawnArgs, cwd: spawnCwd, env: spawnEnv, cols, rows });
      return handle;
    } catch (error) {
      generations.delete(generationKey(id, generation));
      sessions.delete(handle);
      if (latestGeneration.get(id) === generation) {
        if (previousGeneration === undefined) latestGeneration.delete(id);
        else latestGeneration.set(id, previousGeneration);
      }
      throw error;
    }
  }

  async function stop() {
    if (stopped) return;
    const kills = [...sessions].map((session) => session.kill().catch(() => {}));
    const graceful = new Promise((resolve) => setTimeout(resolve, stopTimeoutMs));
    await Promise.race([Promise.allSettled(kills), graceful]);
    stopped = true;
    child?.stdin.end();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      graceful,
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
  }

  return { start, spawn: spawnPty, stop };
}
