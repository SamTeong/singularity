import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultBinary = resolve(__dirname, '..', 'rust', 'backend', 'target', 'release', process.platform === 'win32' ? 'singularity-backend.exe' : 'singularity-backend');
const childEnv = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR']
  .filter((key) => process.env[key] !== undefined)
  .map((key) => [key, process.env[key]]));

function wikiOrder(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch { return []; }
}

export function createRustBackend({ binaryPath = defaultBinary, spawnProcess = spawn } = {}) {
  let child;
  let lines;
  let startPromise;
  let closed = false;
  let busy = false;
  const queue = [];
  const request = (body) => {
    if (!child || closed) return Promise.reject(new Error('Rust backend is not running'));
    return new Promise((resolveRequest, rejectRequest) => {
      queue.push({ request: body, resolve: resolveRequest, reject: rejectRequest });
      pump();
    });
  };

  const fail = (error) => {
    closed = true;
    child?.stdin?.destroy();
    while (queue.length) queue.shift().reject(error);
  };

  const pump = () => {
    if (closed || busy || queue.length === 0) return;
    busy = true;
    const item = queue[0];
    try {
      child.stdin.write(`${JSON.stringify(item.request)}\n`, (error) => {
        if (error) fail(error);
      });
    } catch (error) { fail(error); }
  };

  return {
    start() {
      if (startPromise) return startPromise;
      if (child) return Promise.resolve();
      startPromise = new Promise((resolveStart, rejectStart) => {
        let ready = false;
        let settled = false;
        const startupTimer = setTimeout(() => {
          const error = new Error('Rust backend startup timed out waiting for ready signal');
          fail(error);
          if (!settled) { settled = true; rejectStart(error); }
          child?.kill();
        }, 10000);
        const rejectStartup = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(startupTimer);
          rejectStart(error);
        };
        const resolveStartup = () => {
          if (settled) return;
          settled = true;
          clearTimeout(startupTimer);
          resolveStart();
        };
        child = spawnProcess(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: childEnv });
        child.once('error', (error) => { fail(error); rejectStartup(error); });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => process.stderr.write(`[rust-backend] ${chunk}`));
        lines = createInterface({ input: child.stdout });
        lines.on('line', (line) => {
          let response;
          try { response = JSON.parse(line); }
          catch { return fail(new Error('Rust backend returned invalid JSON')); }
          if (!ready) {
            if (response?.ready !== true) {
              const error = new Error('Rust backend returned invalid startup handshake');
              fail(error);
              rejectStartup(error);
              child.kill();
              return;
            }
            ready = true;
            resolveStartup();
            return;
          }
          const item = queue.shift();
          if (!item) return fail(new Error('Rust backend returned an unsolicited response'));
          item.resolve(response);
          busy = false;
          pump();
        });
        child.once('exit', (code, signal) => {
          const error = new Error(ready
            ? `Rust backend exited (${signal || code})`
            : `Rust backend exited before ready (${signal || code})`);
          fail(error);
          rejectStartup(error);
        });
      });
      return startPromise;
    },

    graph(root, wiki) {
      return request({ root, wiki });
    },

    files(root) {
      return request({ op: 'files', root, wiki_order: wikiOrder(root) }).then((payload) => {
        payload.wikis?.sort((a, b) => a.name.localeCompare(b.name));
        for (const wiki of payload.wikis || []) wiki.pages?.sort((a, b) => a.rel.localeCompare(b.rel));
        return payload;
      });
    },

    sweeps(root) {
      return request({ op: 'sweeps', root });
    },

    search(q, root) {
      return request({ op: 'search', q, root, wiki_order: wikiOrder(root) }).then((payload) => {
        payload.results?.sort((a, b) => a.rel.split('/')[0].localeCompare(b.rel.split('/')[0]));
        for (const result of payload.results || []) result.text = result.text.slice(0, 200);
        return payload;
      });
    },

    planSessions(root) {
      return request({ op: 'plan_sessions', root });
    },

    planSession(dir, sid) {
      return request({ op: 'plan_session', path: dir, sid });
    },

    modelPrices(path) {
      return request({ op: 'model_prices', path }).then((payload) => {
        if (payload.error) throw new Error(payload.error);
        const { pricing, base_keys: keys = [] } = payload;
        const source = pricing.base;
        const base = {};
        const copyKey = (key) => Object.defineProperty(base, key, {
          value: source[key], enumerable: true, configurable: true, writable: true,
        });
        for (const key of keys) if (Object.hasOwn(source, key)) copyKey(key);
        for (const key of Object.keys(source)) if (!Object.hasOwn(base, key)) copyKey(key);
        return { ...pricing, base };
      });
    },

    modelsGet(path) {
      return request({ op: 'models_get', path });
    },

    modelsSet(path, state) {
      return request({ op: 'models_set', path, state });
    },

    modelsRestore(path) {
      return request({ op: 'models_restore', path });
    },

    modelRoute(path, model, tool) {
      return request({ op: 'model_route', path, model: model ?? null, tool: tool ?? null });
    },

    modelsSummariser(path) {
      return request({ op: 'models_summariser', path });
    },

    ruleReference(path, root) {
      return request({ op: 'rule_reference', path, root });
    },

    ruleFiles(scans) {
      return request({ op: 'rules_files', roots: scans });
    },

    ruleSearch(scans, q) {
      return request({ op: 'rules_search', roots: scans, q }).then((payload) => {
        // Rust covers whole UTF-16 chars (may exceed 200 by one); trim to the
        // JS slice(0, 200) contract, as the wiki search does.
        for (const result of payload.results || []) result.text = result.text.slice(0, 200);
        return payload;
      });
    },

    ruleWrite(path, content, mtime, force) {
      return request({
        op: 'rules_write',
        path,
        content,
        mtime: mtime == null ? null : Number(mtime),
        force: !!force,
      });
    },

    skillsList(root) {
      return request({ op: 'skills_list', root });
    },

    skillRead(root, scope, skill, flat) {
      return request({ op: 'skill_read', root, scope, skill, flat });
    },

    skillFileRead(root, scope, skill, file, flat) {
      return request({ op: 'skill_file_read', root, scope, skill, file, flat });
    },

    skillWrite(path, content, mtime, force) {
      return request({
        op: 'skill_write',
        path,
        content,
        mtime: mtime == null ? null : Number(mtime),
        force: !!force,
      });
    },

    memoryWrite(path, content, mtime, force) {
      return request({
        op: 'memory_write',
        path,
        content,
        mtime: mtime == null ? null : Number(mtime),
        force: !!force,
      });
    },

    configWrite(path, content, mtime, force) {
      return request({
        op: 'config_write',
        path,
        content,
        mtime: mtime == null ? null : Number(mtime),
        force: !!force,
      });
    },

    codexConfigWrite(path, content, mtime, force) {
      return request({
        op: 'codex_config_write',
        path,
        content,
        mtime: mtime == null ? null : Number(mtime),
        force: !!force,
      });
    },

    hooksWrite(path, content, mtime, force) {
      return request({
        op: 'hooks_write',
        path,
        content,
        mtime: mtime == null ? null : Number(mtime),
        force: !!force,
      });
    },

    explorerStateGet(path) {
      return request({ op: 'explorer_state_get', path });
    },

    explorerStateSet(path, state) {
      return request({ op: 'explorer_state_set', path, state });
    },

    explorerWrite(path, content, mtime, force) {
      return request({ op: 'explorer_write', path, content, mtime: mtime == null ? null : Number(mtime), force: !!force });
    },

    explorerCreate(path, kind) {
      return request({ op: 'explorer_create', path, kind });
    },

    explorerDelete(path) {
      return request({ op: 'explorer_delete', path });
    },

    explorerRename(from, to) {
      return request({ op: 'explorer_rename', from, to });
    },

    // execFile-shaped one-shot CLI exec: resolves { stdout }, rejects with an
    // error carrying the captured stdout (one-shot.mjs's claude branch reads
    // the JSON reason out of it) and the timeout/exit cause.
    async oneShot(bin, args, opts) {
      const payload = await request({
        op: 'oneshot', bin, args: args ?? [], timeout_ms: opts?.timeout ?? null,
        max_buffer: opts?.maxBuffer ?? null, env: opts?.env ?? null,
      });
      if (payload.ok) return { stdout: payload.stdout };
      const argv = [bin, ...(args ?? [])].join(' ');
      const tail = String(payload.stderr || '').trim().split(/\r?\n/).pop() || '';
      const message = payload.timed_out
        ? `Command timed out after ${opts?.timeout}ms: ${argv}`
        : `Command failed: ${argv}${tail ? `\n${tail}` : ''}`;
      const error = new Error(message);
      error.stdout = payload.stdout ?? undefined;
      error.stderr = payload.stderr ?? undefined;
      error.code = payload.code ?? undefined;
      error.killed = !!payload.timed_out;
      throw error;
    },

    // Guarded PID kill for procs.mjs: { ok } | { ok:false, error } — Node keeps
    // the scan/classification/daemon-denial/TOCTOU decisions.
    procsKill(pid) {
      return request({ op: 'procs_kill', pid });
    },

    readFile(path) {
      return request({ op: 'read', path });
    },

    async stop() {
      if (!child || closed) return;
      closed = true;
      lines?.close();
      child.stdin.end();
      const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
      let timer;
      const timeout = new Promise((resolveExit) => { timer = setTimeout(() => { child.kill(); resolveExit(); }, 2000); });
      await Promise.race([exited, timeout]);
      clearTimeout(timer);
      while (queue.length) queue.shift().reject(new Error('Rust backend stopped'));
    },
  };
}

export function createWikiGraphHandler(backend, logger) {
  return async (req, reply) => {
    try { return await backend.graph(req.query.root ?? '', req.query.wiki ?? ''); }
    catch (error) {
      logger.error({ err: error.message }, 'Rust wiki graph backend failed');
      reply.code(500);
      return { error: 'wiki graph backend unavailable' };
    }
  };
}

export function createModelPricesHandler(backend, path, logger) {
  return async (req, reply) => {
    try { return await backend.modelPrices(path); }
    catch (error) {
      logger.error({ err: error.message }, 'Rust model prices backend failed');
      reply.code(500);
      return { error: 'model prices backend unavailable' };
    }
  };
}

export function createModelsHandlers(backend, path, logger) {
  const unavailable = (error, reply) => {
    logger.error({ err: error.message }, 'Rust models backend failed');
    reply.code(500);
    return { error: 'models backend unavailable' };
  };
  return {
    get: async (_req, reply) => {
      try { return await backend.modelsGet(path); }
      catch (error) { return unavailable(error, reply); }
    },
    set: async (req, reply) => {
      try {
        const result = await backend.modelsSet(path, req.body);
        if (!result.ok) reply.code(400);
        return result;
      } catch (error) { return unavailable(error, reply); }
    },
    restore: async (_req, reply) => {
      try { return { ok: true, state: await backend.modelsRestore(path) }; }
      catch (error) { return unavailable(error, reply); }
    },
  };
}
