// Session-history chat: stream an answer from the Claude Messages API, grounded
// in one session's transcript (scope 'one') or a directory of recent sessions
// (scope 'all'). Reuses the Claude Code OAuth token (claudeOauthToken from
// usage.mjs) — free on the user's subscription. Streams over the daemon WS via
// the `send` callback; `signal` aborts (new chat cancels the prior).
//
// The OAuth Messages endpoint requires the `system` field to begin with the
// exact Claude Code identity string for non-Haiku models (GH #35724/#40515),
// else a generic 400. We prepend it always and run Haiku 4.5 (exempt) — the
// constraint is moot, but the prefix is harmless and keeps a future model swap
// from silently 400-ing.
import { claudeOauthToken } from './usage.mjs';
import { listSessions, sessionText } from './sessions.mjs';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 2048;
const ALL_CAP = 60000;   // scope 'all' context cap (chars)

// Shared between the streaming session-chat path (streamChat) and the plain
// batched path (callMessages, used by history.mjs's day summarizer).
function messagesHeaders(accessToken) {
  return {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
    'user-agent': 'claude-cli/1.0',
    'x-app': 'cli',
  };
}

// Build the context block prepended to the identity string. `root` is the
// client-selected sessions root (optional — defaults to the FS-persisted
// choice, see sessions.mjs).
async function contextFor({ scope, project, id, source, file, root }) {
  if (scope === 'one' && project && id) {
    const text = await sessionText(project, id, undefined, root, source, file);
    if (!text) return '\n\nThe selected session transcript is empty.';
    return `\n\nYou are answering questions about ONE Claude Code session. Below is its transcript. Cite turns by role when useful.\n\n<session>\n${text}\n</session>`;
  }
  // scope 'all': a directory of the most recent sessions (metadata only — full
  // text of every session won't fit). The user can open/search a specific one
  // to drill in.
  const dirs = await listSessions({ cap: 100, root });
  if (!dirs.length) return '\n\nNo sessions found.';
  const lines = dirs.map((s) => `- ${s.title || s.id}  (${s.cwd || s.project}, ${new Date(s.mtime).toISOString().slice(0, 10)})`);
  let text = lines.join('\n');
  if (text.length > ALL_CAP) text = `${text.slice(0, ALL_CAP)}\n…(+${dirs.length} sessions, truncated)`;
  return `\n\nYou are answering questions about the user's Claude Code sessions. Below is a directory of recent sessions (title, cwd, date). Answer about what was worked on; suggest specific sessions to open for detail.\n\n<sessions>\n${text}\n</sessions>`;
}

// Parse an SSE chunk stream from the Messages API, emitting text deltas. The
// reader is driven incrementally so a buffer can straddle chunk boundaries.
// Returns true if a terminal event (chat:done/chat:error) was already sent
// (or the stream was aborted), false if the connection just ended quietly.
export async function consumeStream(body, send, chatId, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    if (signal?.aborted) { try { await reader.cancel(); } catch {} return true; }
    let value, done;
    try {
      ({ value, done } = await reader.read());
    } catch (e) {
      if (signal?.aborted) return true; // aborted mid-read: superseded chat, emit nothing
      throw e;
    }
    if (done) return false;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      let payload;
      try { payload = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
      if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
        send({ t: 'chat:delta', chatId, text: payload.delta.text });
      } else if (payload.type === 'error') {
        send({ t: 'chat:error', chatId, msg: payload.error?.message || 'upstream error' });
        return true;
      } else if (payload.type === 'message_stop') {
        send({ t: 'chat:done', chatId });
        return true;
      }
    }
  }
}

export async function streamChat({ chatId, question, scope = 'one', project, id, source, file, history = [], root }, send, signal) {
  const oauth = claudeOauthToken();
  if (!oauth) {
    send({ t: 'chat:error', chatId, needsAuth: true, msg: 'Claude not signed in — run `claude` to log in' });
    return;
  }
  const system = IDENTITY + await contextFor({ scope, project, id, source, file, root });
  const messages = [...history, { role: 'user', content: question }];

  let resp;
  try {
    resp = await fetch(MESSAGES_URL, {
      method: 'POST',
      signal,
      headers: messagesHeaders(oauth.accessToken),
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages, stream: true }),
    });
  } catch (e) {
    if (signal?.aborted) return;
    send({ t: 'chat:error', chatId, msg: `request failed: ${e.message}` });
    return;
  }
  if (resp.status === 401) { send({ t: 'chat:error', chatId, needsAuth: true, msg: 'auth expired — re-run `claude` to log in' }); return; }
  if (resp.status === 429) { send({ t: 'chat:error', chatId, msg: 'rate-limited — try again shortly' }); return; }
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try { const j = await resp.json(); msg = j.error?.message || msg; } catch {}
    send({ t: 'chat:error', chatId, msg });
    return;
  }
  let sentTerminal;
  try {
    sentTerminal = await consumeStream(resp.body, send, chatId, signal);
  } catch (e) {
    if (signal?.aborted) return; // superseded chat — emit nothing
    send({ t: 'chat:error', chatId, msg: `stream failed: ${e.message}` });
    return;
  }
  // Non-abort exit without an explicit message_stop (e.g. network end) → done.
  if (!sentTerminal && !signal?.aborted) send({ t: 'chat:done', chatId });
}

// Non-streaming Messages API call — same OAuth token, identity prefix, and
// model as streamChat, but stream:false and returns the full text instead of
// pushing deltas over a WS. Used by history.mjs's day summarizer, where a
// plain batched call fits better than a stream. Never throws — HTTP/network
// failures come back as {ok:false, error, status?} so callers can fall
// through to their own next rung.
export async function callMessages({ system, messages, maxTokens = 1024 }) {
  const oauth = claudeOauthToken();
  if (!oauth) return { ok: false, error: 'not signed in' };
  let resp;
  try {
    resp = await fetch(MESSAGES_URL, {
      method: 'POST',
      headers: messagesHeaders(oauth.accessToken),
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system: `${IDENTITY}\n\n${system}`, messages, stream: false }),
    });
  } catch (e) {
    return { ok: false, error: `request failed: ${e.message}` };
  }
  if (resp.status === 401) return { ok: false, error: 'auth expired', status: 401 };
  if (resp.status === 429) return { ok: false, error: 'rate-limited', status: 429 };
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try { const j = await resp.json(); msg = j.error?.message || msg; } catch {}
    return { ok: false, error: msg, status: resp.status };
  }
  const data = await resp.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { ok: true, text, model: data.model || MODEL, inputTokens: data.usage?.input_tokens ?? null, outputTokens: data.usage?.output_tokens ?? null };
}
