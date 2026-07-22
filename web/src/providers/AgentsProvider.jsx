/**
 * AgentsProvider — the app's domain-state boundary.
 *
 * Owns the daemon WebSocket (auto-reconnect + hidden-tab handling), the derived
 * fleet state it pushes (agents, tasks, crons, background, usage), the per-agent
 * polling (stats, subagents), and the actions that talk back to the daemon.
 * Shell components read this through {@link useAgents} instead of receiving a
 * dozen drilled props, which is what let `App.jsx` shrink to orchestration.
 *
 * Colour/theme is a separate concern (see `theme/AppThemeProvider`). UI-only
 * state that never leaves the shell (view, collapsed, dialog open flags, toast)
 * stays in the shell, not here.
 */
import { createContext, use, useCallback, useEffect, useRef, useState } from 'react';
import { setHome } from '@/lib/paths.js';

const WS_URL = `ws://${location.host}/ws${window.__SING_TOKEN__ ? `?token=${encodeURIComponent(window.__SING_TOKEN__)}` : ''}`;

/** @type {React.Context<any>} */
const AgentsContext = createContext(null);

export function AgentsProvider({ children }) {
  const [agents, setAgents] = useState([]);
  const [active, setActive] = useState(null);
  const [connected, setConnected] = useState(false);
  const [recent, setRecent] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [taskHistory, setTaskHistory] = useState([]);
  const [crons, setCrons] = useState([]);
  const [background, setBackground] = useState(null); // { config, lastTick, liveTaskId }
  const [usage, setUsage] = useState(null); // { ollama, claude } from /usage
  const [stats, setStats] = useState({}); // id -> {turns, tokens}
  const [subagents, setSubagents] = useState({}); // agentId -> [{agentId, title, running, mtime}]
  const wsRef = useRef(null);
  const termHandlers = useRef({}); // id -> { write(data), reset() }
  const chatHandler = useRef(null); // session-history chat -> {t:'chat:*', ...}
  const errorHandler = useRef(null); // shell-registered toast sink for daemon 'error' frames

  // WS with auto-reconnect (exponential backoff, 0.5s → 8s). On reconnect the
  // fresh socket has no attachments — re-attach every mounted terminal, each
  // reset first so the scrollback replay doesn't duplicate content.
  useEffect(() => {
    let ws, timer, unmounted = false, delay = 500;
    const connect = () => {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        delay = 500;
        for (const [id, h] of Object.entries(termHandlers.current)) {
          h.reset();
          ws.send(JSON.stringify({ t: 'attach', id }));
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!unmounted) { timer = setTimeout(connect, delay); delay = Math.min(delay * 2, 8000); }
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t === 'list') {
          setAgents(m.agents);
          if (m.recentRepos) setRecent(m.recentRepos);
          setActive((cur) => (cur && m.agents.some((a) => a.id === cur) ? cur : m.agents[0]?.id ?? null));
        } else if (m.t === 'status') {
          setAgents((as) => as.map((a) => (a.id === m.id ? { ...a, status: m.status } : a)));
        } else if (m.t === 'output') {
          // Drop output while the tab is hidden. xterm flushes its internal
          // write buffer on a timer, but browsers throttle background-tab
          // timers to ~1/min — a continuously-streaming session (Claude's TUI
          // spinner) then accumulates an unbounded write buffer overnight →
          // tab OOM. The daemon keeps a 256KB ring and replays it on re-attach
          // (visibilitychange effect below), so nothing is lost.
          if (!document.hidden) termHandlers.current[m.id]?.write(m.data);
        } else if (m.t === 'attached') {
          setActive(m.id);
        } else if (m.t === 'usage') {
          setUsage(m.data);
        } else if (m.t === 'tasks') {
          setTasks(m.tasks);
          setTaskHistory(m.history || []);
        } else if (m.t === 'crons') {
          setCrons(m.crons);
        } else if (m.t === 'background') {
          setBackground({ config: m.config, lastTick: m.lastTick, liveTaskId: m.liveTaskId });
        } else if (m.t === 'chat:delta' || m.t === 'chat:done' || m.t === 'chat:error') {
          chatHandler.current?.(m);
        } else if (m.t === 'error') {
          errorHandler.current?.(m.msg);
        }
      };
    };
    connect();
    return () => { unmounted = true; clearTimeout(timer); ws.close(); };
  }, []);

  // Tab hidden → live output is dropped (see onmessage). On regain, reset each
  // terminal and re-attach so the daemon replays current scrollback — same path
  // as WS reconnect.
  useEffect(() => {
    const onVis = () => {
      const ws = wsRef.current;
      if (document.hidden || ws?.readyState !== WebSocket.OPEN) return;
      for (const [id, h] of Object.entries(termHandlers.current)) {
        h.reset();
        ws.send(JSON.stringify({ t: 'attach', id }));
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Home dir, for tildify() to collapse full paths to `~` on display.
  useEffect(() => { fetch('/env').then((r) => r.json()).then((d) => setHome(d.home)).catch(() => {}); }, []);

  const sendMsg = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  // Drag-and-drop reorder: optimistically move dragId onto overId's slot, then
  // tell the server to persist the new order (it re-emits 'list').
  const reorderAgents = useCallback((dragId, overId) => {
    if (!dragId || dragId === overId) return;
    setAgents((cur) => {
      const ids = cur.map((a) => a.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(overId);
      if (from < 0 || to < 0) return cur;
      ids.splice(from, 1);
      ids.splice(to, 0, dragId);
      sendMsg({ t: 'reorder', ids });
      return ids.map((id) => cur.find((a) => a.id === id));
    });
  }, [sendMsg]);

  const registerTerminal = useCallback((id, fn) => {
    if (fn) termHandlers.current[id] = fn;
    else delete termHandlers.current[id];
  }, []);

  const registerChat = useCallback((cb) => { chatHandler.current = cb; }, []);

  // Error sink — the shell registers its toast setter so daemon 'error' frames
  // surface without this provider owning UI state.
  const registerError = useCallback((cb) => { errorHandler.current = cb; }, []);

  // Poll per-agent stats (turns/tokens from each session .jsonl).
  const agentKey = agents.map((a) => a.id).join(',');
  useEffect(() => {
    if (!connected) return undefined;
    const pull = () => fetch('/agent-stats').then((r) => r.json()).then((d) => setStats(d.stats || {})).catch(() => {});
    pull();
    const t = setInterval(pull, 8000);
    return () => clearInterval(t);
  }, [connected, agentKey]);

  // Poll live subagents — indicator-only rows nested under the dock agent row.
  // Server scopes this to live agents, so it stays cheap (no full-history scan).
  useEffect(() => {
    if (!connected) return undefined;
    const pull = () => fetch('/subagents').then((r) => r.json()).then((d) => setSubagents(d.subagents || {})).catch(() => {});
    pull();
    const t = setInterval(pull, 5000);
    return () => clearInterval(t);
  }, [connected, agentKey]);

  // Usage (Ollama Cloud + Claude 5h/7d). On-demand only — no interval poll.
  // Server caches ~60s so repeated opens are cheap; force=1 bypasses.
  const refreshUsage = useCallback((force = false) => {
    fetch(`/usage${force ? '?force=1' : ''}`).then((r) => r.json()).then(setUsage).catch(() => {});
  }, []);

  // On-demand: fetch once the socket is up (app opened / reconnected). The
  // backend pushes 'usage' updates on its own auto-refresh from here on.
  useEffect(() => { if (connected) refreshUsage(false); }, [connected, refreshUsage]);

  // Background snapshot: initial load on connect; live updates arrive over the WS.
  useEffect(() => {
    if (!connected) return;
    fetch('/background').then((r) => r.json()).then(setBackground).catch(() => {});
  }, [connected]);

  const value = {
    agents, active, setActive, connected, recent,
    tasks, taskHistory, crons, background, usage,
    stats, subagents,
    sendMsg, reorderAgents, refreshUsage,
    registerTerminal, registerChat, registerError,
  };
  return <AgentsContext value={value}>{children}</AgentsContext>;
}

/**
 * Read fleet/domain state and actions from {@link AgentsProvider}.
 * @returns {object} the agents context (agents, active, tasks, actions, …)
 */
export function useAgents() {
  const ctx = use(AgentsContext);
  if (!ctx) throw new Error('useAgents must be used within <AgentsProvider>');
  return ctx;
}
