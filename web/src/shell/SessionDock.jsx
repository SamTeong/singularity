import { getTokens } from '@/theme/contract.js';
import { useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import List from '@mui/material/List';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import TerminalIcon from '@mui/icons-material/Terminal';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { EmptyState } from '@zapac/mui-theme';
import Terminal from '@/features/sessions/Terminal.jsx';
import { ResizeHandle } from '@/hooks/useResizable.jsx';
import { nextSessionTitle, nextCycledSession } from '@/lib/sessionTitle.js';
import { tildify } from '@/lib/paths.js';
import { useAgents } from '@/providers/AgentsProvider.jsx';
import { glass, surface2, stroke2, chipBg, statusColor, focusRing } from '@/shell/shellStyles.js';
import SessionRow from '@/shell/SessionRow.jsx';

// Cap live terminals: each mounted xterm holds a full scrollback buffer, so
// mounting every agent's terminal grows memory without bound. Keep the active
// agent + the most-recently-viewed few mounted (instant switch); the daemon
// replays scrollback on re-attach for the rest.
// ponytail: MRU list, bump the cap if switching to an evicted agent feels slow.
const MOUNT_LRU = 4;

// layout-02 `.sess-led` — the 8px status dot in the terminal bar. Mid-turn gets
// the info hue plus its halo (`.run`); at-the-prompt is calm ok (`.done`);
// anything detached/exited is inert ink-3 (`.idle`).
const LED = { starting: 'info', running: 'info', idle: 'ok' };
const sessionLed = (t, status) => {
  const kind = LED[status];
  const c = kind ? statusColor(t, kind) : t.vars.palette.text.disabled;
  return {
    width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: c,
    ...(status === 'running' || status === 'starting'
      ? { boxShadow: `0 0 0 3px color-mix(in srgb, ${c} 24%, transparent)` }
      : null),
  };
};

/**
 * Terminal dock — full width, below sidebar + view: session list (left) +
 * selected terminal (right). Owns drag-reorder and terminal-mount LRU state
 * locally; fleet state + actions come from {@link useAgents}. Dock size/minimise
 * state is shell-owned and passed in (shared with the create dialogs).
 */
export default function SessionDock({ dockMin, toggleDock, dockH, listW, expandDock, onTopReached, onViewTranscript, onToast }) {
  const { agents, active, setActive, subagents, stats, sendMsg, reorderAgents, registerTerminal } = useAgents();
  const [dragId, setDragId] = useState(null);

  // MRU of viewed agents → the set kept mounted. Real state (not a ref) since
  // it drives rendering below; updated during render (React's documented
  // "adjust state on prop change" pattern) so the active agent is always
  // mounted first in the same pass it becomes active.
  const [mru, setMru] = useState(() => (active ? [active] : []));
  if (active && mru[0] !== active) {
    setMru((m) => [active, ...m.filter((id) => id !== active)]);
  }
  const mountedSet = new Set(mru.slice(0, MOUNT_LRU));

  const activeAgent = agents.find((a) => a.id === active);
  const cycleSession = (dir) => {
    const next = nextCycledSession(agents, active, dir);
    if (next) setActive(next);
  };

  return (
    <Box sx={(t) => ({ ...glass(t), position: 'relative', zIndex: getTokens(t).layers.content, flexShrink: 0, height: dockMin ? 'auto' : dockH, mx: 1.5, mb: 1.5, mt: dockMin ? 1.5 : 0, borderRadius: `${getTokens(t).radius.lg}px`, overflow: 'hidden', display: 'flex', flexDirection: 'column' })}>
      <Stack direction="row" spacing={1} role="button" tabIndex={0} onClick={toggleDock} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDock(); } }} title={dockMin ? 'Restore' : 'Minimize'} sx={(t) => ({ px: 1.5, height: 36, flexShrink: 0, display: 'flex', alignItems: 'center', cursor: 'pointer', userSelect: 'none', borderBottom: dockMin ? 'none' : `1px solid ${stroke2(t)}`, '&:focus-visible': focusRing(t) })}>
        <SmartToyIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
        {/* Label + count stay grouped (`.dock-list-head`), so the count reads as
            "how many sessions" rather than floating at the far edge of the dock. */}
        <Typography sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'text.secondary' }} noWrap>Sessions</Typography>
        <Box sx={(t) => ({ fontSize: 11, fontWeight: 700, color: 'text.disabled', background: chipBg(t), px: '8px', py: '2px', borderRadius: 999, lineHeight: 1.4 })}>{agents.length}</Box>
        <Box sx={{ flex: 1 }} />
        {dockMin ? <ExpandMoreIcon sx={{ fontSize: 18, color: 'text.secondary' }} /> : <ExpandLessIcon sx={{ fontSize: 18, color: 'text.secondary' }} />}
      </Stack>

      {/* Body kept mounted while minimized (display:none) so terminals keep
          their live xterm + scrollback. */}
      <Box sx={{ display: dockMin ? 'none' : 'flex', flex: 1, minHeight: 0 }}>
        <List sx={(t) => ({ width: listW.width, flexShrink: 0, overflow: 'auto', px: 1, py: 0.5, borderRight: `1px solid ${stroke2(t)}`, background: surface2(t) })}>
          {agents.map((a) => (
            <SessionRow
              key={a.id}
              agent={a}
              selected={a.id === active}
              onSelect={() => setActive(a.id)}
              stats={stats[a.id]}
              subagents={subagents[a.id] || []}
              dragging={dragId === a.id}
              dragHandlers={{
                onDragStart: () => setDragId(a.id),
                onDragOver: (e) => e.preventDefault(),
                onDrop: () => { reorderAgents(dragId, a.id); setDragId(null); },
                onDragEnd: () => setDragId(null),
              }}
              onViewTranscript={() => onViewTranscript(a)}
              onDuplicate={() => { sendMsg({ t: 'create', cwd: a.cwd, title: nextSessionTitle(agents, a), model: a.model, scopes: a.scopes }); expandDock(); }}
              onFork={() => sendMsg({ t: 'fork', id: a.id, title: nextSessionTitle(agents, a) })}
              onRespawn={() => sendMsg({ t: 'respawn', id: a.id })}
              onReattach={() => sendMsg({ t: 'reattach', id: a.id })}
              onOpenExternal={() => fetch('/session/external', {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: a.id }),
              }).then((r) => r.json()).then((d) => { if (!d.ok && onToast) onToast(`External terminal failed: ${d.error || 'unknown'}`); }).catch(() => { if (onToast) onToast('External terminal failed: network error'); })}
              onKill={() => sendMsg({ t: 'kill', id: a.id })}
            />
          ))}
        </List>

        {/* Drag handle — resize the session-list width. layout-02 `.list-handle`:
            8px hit strip, grip fades in on hover/drag/focus. */}
        <ResizeHandle
          axis="x"
          onPointerDown={listW.startDrag}
          onKeyDown={listW.onKeyDown}
          dragging={listW.dragging}
          value={listW.width}
          min={listW.min}
          max={listW.max}
          label="Resize session list"
        />

        {/* Terminal pane: a glass term-bar header (display-only chrome showing
            the active session title) over the mounted terminals. `.term` sits a
            step deeper than the dock glass — recessed on light, near-black on
            dark — so the terminal reads as a well, not another panel. */}
        <Box
          sx={(t) => ({
            flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
            background: t.palette.mode === 'dark' ? 'rgba(0,0,0,.34)' : surface2(t),
          })}
        >
          {/* layout-02 `.term-bar`: status LED, then mono "<b>title</b> · model
              · cwd" — the active session's identity at a glance. */}
          <Stack direction="row" sx={(t) => ({ alignItems: 'center', gap: '10px', px: '16px', py: '10px', flexShrink: 0, borderBottom: `1px solid ${stroke2(t)}` })}>
            {activeAgent
              ? <Box aria-hidden sx={(t) => sessionLed(t, activeAgent.status)} />
              : <TerminalIcon sx={{ fontSize: 14, color: 'text.secondary' }} />}
            <Typography variant="code" sx={{ fontSize: 12, color: 'text.secondary', minWidth: 0 }} noWrap>
              {activeAgent ? (
                <>
                  <Box component="b" sx={{ color: 'text.primary', fontWeight: 700 }}>{activeAgent.title}</Box>
                  {activeAgent.model ? ` · ${activeAgent.model}` : ''}
                  {activeAgent.cwd ? ` · ${tildify(activeAgent.cwd)}` : ''}
                </>
              ) : 'No session'}
            </Typography>
          </Stack>
          {/* Selected terminal. All non-detached terminals stay mounted
              (display:none when hidden) so scrollback + WS attach survive. */}
          <Box sx={{ position: 'relative', flex: 1, minWidth: 0, p: 0.5 }}>
            {agents.filter((a) => a.status !== 'detached' && mountedSet.has(a.id)).map((a) => {
              const show = !dockMin && a.id === active;
              return (
                <Box key={a.id} sx={{ position: 'absolute', inset: 0, display: show ? 'block' : 'none' }}>
                  <Terminal agent={a} visible={show} sendMsg={sendMsg} onSwitch={cycleSession} registerOutput={registerTerminal} onTopReached={() => onTopReached(a)} />
                </Box>
              );
            })}
            {(!activeAgent || activeAgent.status === 'detached') && (
              <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
                <EmptyState
                  icon={<TerminalIcon />}
                  title={activeAgent?.status === 'detached' ? 'Session paused' : 'No agent selected'}
                  description={activeAgent?.status === 'detached' ? 'Click Resume to continue this session.' : 'Create an agent to begin.'}
                />
              </Box>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
