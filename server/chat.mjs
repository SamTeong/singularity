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

// Build the context block prepended to the identity string.
function contextFor({ scope, project, id }) {
  if (scope === 'one' && project && id) {
    const text = sessionText(project, id);
    if (!text) return '\n\nThe selected session transcript is empty.';
    return `\n\nYou are answering questions about ONE Claude Code session. Below is its transcript. Cite turns by role when useful.\n\n<session>\n${text}\n</session>`;
  }
  // scope 'all': a directory of the most recent sessions (metadata only — full
  // text of every session won't fit). The user can open/search a specific one
  // to drill in.
  const dirs = listSessions({ cap: 100 });
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

export async function streamChat({ chatId, question, scope = 'one', project, id, history = [] }, send, signal) {
  const oauth = claudeOauthToken();
  if (!oauth) {
    send({ t: 'chat:error', chatId, needsAuth: true, msg: 'Claude not signed in — run `claude` to log in' });
    return;
  }
  const system = IDENTITY + contextFor({ scope, project, id });
  const messages = [...history, { role: 'user', content: question }];

  let resp;
  try {
    resp = await fetch(MESSAGES_URL, {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${oauth.accessToken}`,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
        'user-agent': 'claude-cli/1.0',
        'x-app': 'cli',
      },
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
