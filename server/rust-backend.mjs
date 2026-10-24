import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultBinary = process.env.SINGULARITY_RUST_BACKEND_BINARY
  ?? resolve(__dirname, '..', 'rust', 'backend', 'target', 'release', process.platform === 'win32' ? 'singularity-backend.exe' : 'singularity-backend');
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

function oneShotError(payload, bin, args, timeout) {
  const argv = [bin, ...(args ?? [])].join(' ');
  const tail = String(payload.stderr || '').trim().split(/\r?\n/).pop() || '';
  const message = payload.timed_out
    ? `Command timed out after ${timeout}ms: ${argv}`
    : `Command failed: ${argv}${tail ? `\n${tail}` : ''}`;
  const error = new Error(message);
  error.stdout = payload.stdout ?? undefined;
  error.stderr = payload.stderr ?? undefined;
  error.code = payload.code ?? undefined;
  error.killed = !!payload.timed_out;
  return error;
}

export function createRustBackend({ binaryPath = defaultBinary, spawnProcess = spawn } = {}) {
  let child;
  let lines;
  let startPromise;
  let closed = false;
  let busy = false;
  let oneShotBusy = false;
  let nextRequestId = 0;
  const queue = [];
  const pendingStatus = new Map();
  const oneShotQueue = [];
  const pendingOneShot = new Map();
  const requestId = () => `rust-${++nextRequestId}`;
  const request = (body, signal = null, headerTimeoutMs = null) => {
    if (!child || closed) return Promise.reject(new Error('Rust backend is not running'));
    if (signal?.aborted) return Promise.reject(new Error('This operation was aborted'));
    return new Promise((resolveRequest, rejectRequest) => {
      const id = requestId();
      const item = {
        request: { ...body, id }, id, resolve: resolveRequest, reject: rejectRequest, signal, dispatched: false,
        headerDeadline: headerTimeoutMs === null ? null : Date.now() + headerTimeoutMs,
      };
      item.onAbort = () => {
        if (item.dispatched) return;
        const index = queue.indexOf(item);
        if (index < 0) return;
        queue.splice(index, 1);
        signal.removeEventListener('abort', item.onAbort);
        rejectRequest(new Error('This operation was aborted'));
      };
      signal?.addEventListener('abort', item.onAbort, { once: true });
      queue.push(item);
      pump();
    });
  };
  const statusRequest = (force) => {
    if (!child || closed) return Promise.reject(new Error('Rust backend is not running'));
    return new Promise((resolveRequest, rejectRequest) => {
      const id = requestId();
      pendingStatus.set(id, { resolve: resolveRequest, reject: rejectRequest });
      try {
        child.stdin.write(`${JSON.stringify({ op: 'status_get', type: 'status_request', id, force })}\n`, (error) => {
          if (error) fail(error);
        });
      } catch (error) { fail(error); }
    });
  };

  const oneShotRequest = (body) => {
    if (!child || closed) return Promise.reject(new Error('Rust backend is not running'));
    return new Promise((resolveRequest, rejectRequest) => {
      oneShotQueue.push({ body, id: requestId(), resolve: resolveRequest, reject: rejectRequest });
      pumpOneShot();
    });
  };

  const fail = (error) => {
    closed = true;
    child?.stdin?.destroy();
    while (queue.length) {
      const item = queue.shift();
      item.signal?.removeEventListener('abort', item.onAbort);
      item.reject(error);
    }
    for (const pending of pendingStatus.values()) pending.reject(error);
    pendingStatus.clear();
    for (const pending of pendingOneShot.values()) pending.reject(error);
    pendingOneShot.clear();
    while (oneShotQueue.length) oneShotQueue.shift().reject(error);
    oneShotBusy = false;
  };

  const pump = () => {
    if (closed || busy || queue.length === 0) return;
    busy = true;
    const item = queue[0];
    if (item.signal?.aborted || (item.headerDeadline !== null && item.headerDeadline <= Date.now())) {
      queue.shift();
      item.signal?.removeEventListener('abort', item.onAbort);
      item.reject(new Error('This operation was aborted'));
      busy = false;
      pump();
      return;
    }
    if (item.headerDeadline !== null) item.request.header_timeout_ms = item.headerDeadline - Date.now();
    item.dispatched = true;
    try {
      child.stdin.write(`${JSON.stringify(item.request)}\n`, (error) => {
        if (error) fail(error);
      });
    } catch (error) { fail(error); }
  };

  const pumpOneShot = () => {
    if (closed || oneShotBusy || oneShotQueue.length === 0) return;
    oneShotBusy = true;
    const item = oneShotQueue.shift();
    pendingOneShot.set(item.id, item);
    try {
      child.stdin.write(`${JSON.stringify({ ...item.body, id: item.id })}\n`, (error) => {
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
          if (response?.type === 'status_reply' && typeof response.id === 'string') {
            const pending = pendingStatus.get(response.id);
            if (!pending) return fail(new Error('Rust backend returned an unknown status reply ID'));
            pendingStatus.delete(response.id);
            pending.resolve(response.response);
            return;
          }
          if (response?.type === 'oneshot_reply') {
            if (typeof response.id !== 'string' || !Object.hasOwn(response, 'response')) {
              return fail(new Error('Rust backend returned a malformed one-shot reply'));
            }
            const pending = pendingOneShot.get(response.id);
            if (!pending) return fail(new Error('Rust backend returned an unknown one-shot reply ID'));
            pendingOneShot.delete(response.id);
            pending.resolve(response.response);
            oneShotBusy = false;
            pumpOneShot();
            return;
          }
          if (typeof response?.id !== 'string' || !Object.hasOwn(response, 'response')) {
            return fail(new Error('Rust backend returned an uncorrelated response'));
          }
          const item = queue.shift();
          if (!item || item.id !== response.id) return fail(new Error('Rust backend returned an out-of-order ordinary response'));
          item.signal?.removeEventListener('abort', item.onAbort);
          item.resolve(response.response);
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

    sysStats() {
      return request({ op: 'sysstats_get' });
    },

    statusGet(force = false) {
      return statusRequest(force === true);
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

    transcriptRootGet(inputs) {
      return request({ ...inputs, op: 'transcript_root_get' });
    },

    transcriptRootSet(inputs, root) {
      return request({ ...inputs, op: 'transcript_root_set', transcript_root: root });
    },

    transcriptsList(inputs, options) {
      return request({ ...inputs, ...options, op: 'transcripts_list' });
    },

    transcriptRead(inputs, options) {
      return request({ ...inputs, ...options, op: 'transcripts_read' });
    },

    transcriptsSearch(inputs, options) {
      return request({ ...inputs, ...options, op: 'transcripts_search' });
    },

    transcriptSubagents(inputs, options) {
      return request({ ...inputs, ...options, op: 'transcript_subagents' });
    },

    codexThreadFind(codexHome, cwd, spawnedAt) {
      return request({ op: 'codex_thread_find', identity_codex_home: codexHome, cwd, spawned_at: spawnedAt })
        .then((threadId) => typeof threadId === 'string' ? threadId : null)
        .catch(() => null);
    },

    codexThreadExists(codexHome, cwd, threadId) {
      return request({ op: 'codex_thread_exists', identity_codex_home: codexHome, cwd, thread_id: threadId })
        .then((exists) => exists === true)
        .catch(() => false);
    },

    usageReportStatus(reportsDir, skillPath) {
      return request({ op: 'usage_report_status', usage_report: { reports_dir: reportsDir, skill_path: skillPath, env: process.env } });
    },

    usageReportRead(reportsDir, skillPath) {
      return request({ op: 'usage_report_read', usage_report: { reports_dir: reportsDir, skill_path: skillPath, env: process.env } });
    },

    usageReportGenerate(reportsDir, skillPath) {
      return request({ op: 'usage_report_generate', usage_report: { reports_dir: reportsDir, skill_path: skillPath, env: process.env } });
    },

    providerUsageNormalize(provider, payload, { payloadPresent = true, plan, fetchedAt } = {}) {
      return request({ op: 'provider_usage_normalize', provider, payload_present: payloadPresent, payload: payload ?? null, plan, fetched_at: fetchedAt })
        .then((result) => {
          if (result?.error) throw new Error(result.error);
          return result;
        });
    },

    codexUsageResult({ status, retryAfter, nowMs, payloadPresent = false, payload, fetchedAt, error } = {}) {
      return request({
        op: 'codex_usage_result', status, retry_after: retryAfter, now_ms: nowMs,
        payload_present: payloadPresent, payload: payload ?? null, fetched_at: fetchedAt, error,
      }).then((result) => {
        if (result?.ok === false) return result;
        if (result?.error) throw new Error(result.error);
        return result;
      });
    },

    providerUsageSnapshot(input) {
      return request({ ...input, op: 'provider_usage_snapshot' }).then((response) => {
        if (response?.error) throw new Error(response.error);
        return response?.result ?? null;
      });
    },

    codexUsageBegin(authPath) {
      return request({ op: 'codex_usage_begin', path: authPath });
    },

    codexUsageFetch(handle) {
      return request({ op: 'codex_usage_fetch', credential_handle: handle });
    },

    codexUsageRelease(handle) {
      return request({ op: 'codex_usage_release', credential_handle: handle });
    },

    codexAccountFingerprint(authPath) {
      return request({ op: 'codex_account_fingerprint', path: authPath }).then((fingerprint) =>
        typeof fingerprint === 'string' && /^[0-9a-f]{64}$/.test(fingerprint) ? fingerprint : null);
    },

    claudeUsageFetch(accessToken, signal, headerTimeoutMs = 10_000) {
      return request({ op: 'claude_usage_fetch', access_token: accessToken }, signal, headerTimeoutMs);
    },

    claudeOauthRefresh(body, signal, headerTimeoutMs = 10_000) {
      return request({ op: 'claude_oauth_refresh', oauth_body: body }, signal, headerTimeoutMs);
    },

    claudeCredentialsRead(path) {
      return request({ op: 'claude_credentials_read', path });
    },

    claudeCredentialsWrite(path, tempPath, text) {
      return request({ op: 'claude_credentials_write', path, temp_path: tempPath, credential_text: text })
        .then((payload) => payload.ok === true);
    },

    ollamaModeConfigRead(path) {
      return request({ op: 'ollama_mode_config_read', path }).then((payload) => {
        if (payload.kind === 'error') {
          throw new Error(`bad ${payload.path}: ${payload.operation} failed (${payload.error_kind})`);
        }
        return payload;
      });
    },

    ollamaModeConfigWrite(path, tempPath, text) {
      return request({ op: 'ollama_mode_config_write', path, temp_path: tempPath, ollama_config_text: text })
        .then((payload) => {
          if (payload.kind === 'error') {
            throw new Error(`bad ${payload.path}: ${payload.operation} failed (${payload.error_kind})`);
          }
          return payload.ok === true;
        });
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

    modelPricesWrite(path, text) {
      return request({ op: 'model_prices_write', path, pricing_text: text }).then((payload) => {
        if (payload.error) throw new Error(payload.error);
        return payload.ok === true;
      });
    },

    modelsGet(path) {
      return request({ op: 'models_get', path });
    },

    keysGet(path) {
      return request({ op: 'keys_get', path });
    },

    keysSet(path, patch) {
      return request({ op: 'keys_set', path, patch });
    },

    configStateGet(path) {
      return request({ op: 'config_state_get', path });
    },

    configStateSet(path, patch) {
      return request({ op: 'config_state_set', path, patch });
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

    async windowAnchorLoad(path) {
      const result = await request({ op: 'window_anchor_load', path });
      if (result.error) throw new Error(result.error);
      return result.state;
    },

    async windowAnchorSave(path, state) {
      const result = await request({ op: 'window_anchor_save', path, state });
      if (result.error) throw new Error(result.error);
      return result;
    },

    async windowAnchorTelemetry(path, record) {
      const result = await request({ op: 'window_anchor_telemetry', path, record });
      if (result.error) throw new Error(result.error);
      return result;
    },

    windowAnchorRequest(op, fields = {}) {
      return request({ op, ...fields });
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
      const payload = await oneShotRequest({
        op: 'oneshot_async', bin, args: args ?? [], timeout_ms: opts?.timeout ?? null,
        max_buffer: opts?.maxBuffer ?? null, env: opts?.env ?? null,
      });
      if (payload.ok) return { stdout: payload.stdout };
      throw oneShotError(payload, bin, args, opts?.timeout);
    },

    async git(bin, args, opts) {
      const payload = await request({
        op: 'git', bin, args: args ?? [], timeout_ms: opts?.timeout ?? null,
        max_buffer: opts?.maxBuffer ?? null, env: opts?.env ?? null,
      });
      if (payload.ok) return { stdout: payload.stdout };
      const argv = [bin, ...(args ?? [])].join(' ');
      let error;
      if (payload.spawn_error) {
        const rawCode = payload.spawn_error_raw_os_code;
        const code = rawCode === 2 || rawCode === 3 ? 'ENOENT'
          : rawCode === 5 || rawCode === 13 || rawCode === 193 ? 'EACCES'
            : rawCode === 32 ? 'EBUSY' : rawCode === 87 ? 'EINVAL'
              : payload.spawn_error_kind === 'NotFound' ? 'ENOENT'
                : payload.spawn_error_kind === 'PermissionDenied' ? 'EACCES' : 'UNKNOWN';
        error = new Error(`spawn ${bin} ${code}`);
        error.code = code;
        error.cause = payload.error;
        if (rawCode != null) error.errno = rawCode;
      }
      else if (payload.error === 'stdout maxBuffer exceeded' || payload.error === 'stderr maxBuffer exceeded') {
        error = new RangeError(`${payload.error.slice(0, -' maxBuffer exceeded'.length)} maxBuffer length exceeded`);
        error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      } else {
        error = new Error(payload.timed_out
          ? `Command failed: ${argv}`
          : `Command failed: ${argv}${payload.stderr ? `\n${payload.stderr}` : ''}`);
      }
      error.stdout = payload.stdout ?? undefined;
      error.stderr = payload.stderr ?? undefined;
      error.code ??= payload.code ?? undefined;
      error.signal = payload.signal ?? (payload.timed_out ? 'SIGKILL' : null);
      error.killed = !!payload.killed || !!payload.timed_out;
      throw error;
    },

    async spawnDetached(bin, args, cwd, env = process.env) {
      const payload = await request({ op: 'detached_spawn', bin, args: args ?? [], cwd: cwd ?? null, env });
      if (!payload?.ok) throw new Error(payload?.error || 'failed to spawn process');
      return { ok: true };
    },

    async usageKeychain(platform, bin = 'security') {
      const payload = await request({ op: 'usage_keychain', platform, bin, env: process.env });
      return payload?.ok ? payload.oauth ?? null : null;
    },

    async usageAuthStatus(bin, timeout) {
      return request({ op: 'usage_auth_status', bin, timeout_ms: timeout, env: process.env });
    },

    procsScanRaw() {
      return request({ op: 'procs_scan_raw' });
    },

    procsClassify(snapshot, livePids, liveSessions, repoRoot, hostPid) {
      return request({
        op: 'procs_classify',
        procs_snapshot: snapshot,
        live_pids: livePids,
        live_sessions: liveSessions,
        repo_root: repoRoot,
        host_pid: hostPid,
      });
    },

    async procsKillGuarded(pid, name, kind, isDarwin) {
      const payload = await request({ op: 'procs_kill_guarded', pid, name, kind, is_darwin: isDarwin });
      if (payload?.oneshot_failure) {
        throw oneShotError(payload.oneshot_failure, payload.bin, payload.args, payload.timeout_ms);
      }
      return payload;
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
      const error = new Error('Rust backend stopped');
      lines?.close();
      while (queue.length) {
        const item = queue.shift();
        item.signal?.removeEventListener('abort', item.onAbort);
        item.reject(error);
      }
      for (const pending of pendingStatus.values()) pending.reject(error);
      pendingStatus.clear();
      for (const pending of pendingOneShot.values()) pending.reject(error);
      pendingOneShot.clear();
      while (oneShotQueue.length) oneShotQueue.shift().reject(error);
      oneShotBusy = false;
      child.stdin.end();
      const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
      let timer;
      const timeout = new Promise((resolveExit) => { timer = setTimeout(() => { child.kill(); resolveExit(); }, 2000); });
      await Promise.race([exited, timeout]);
      clearTimeout(timer);
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
