import { getTokens } from '@/theme/contract.js';
import { useRef, useState } from 'react';
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
import { nextSessionName, nextCycledSession } from '@/lib/sessionName.js';
import { useAgents } from '@/providers/AgentsProvider.jsx';
import { glass } from '@/shell/shellStyles.js';
import SessionRow from '@/shell/SessionRow.jsx';

// Cap live terminals: each mounted xterm holds a full scrollback buffer, so
// mounting every agent's terminal grows memory without bound. Keep the active
// agent + the most-recently-viewed few mounted (instant switch); the daemon
// replays scrollback on re-attach for the rest.
// ponytail: MRU list, bump the cap if switching to an evicted agent feels slow.
const MOUNT_LRU = 4;

/**
 * Terminal dock — full width, below sidebar + view: session list (left) +
 * selected terminal (right). Owns drag-reorder and terminal-mount LRU state
 * locally; fleet state + actions come from {@link useAgents}. Dock size/minimise
 * state is shell-owned and passed in (shared with the create dialogs).
 */
export default function SessionDock({ dockMin, toggleDock, dockH, startDockDrag, listW, expandDock }) {
  const { agents, active, setActive, subagents, stats, sendMsg, reorderAgents, registerTerminal } = useAgents();
  const [dragId, setDragId] = useState(null);

  // MRU of viewed agents → the set kept mounted. Updated during render so the
  // active agent is always mounted first.
  const mruRef = useRef([]);
  if (active && mruRef.current[0] !== active) {
    mruRef.current = [active, ...mruRef.current.filter((id) => id !== active)];
  }
  const mountedSet = new Set(mruRef.current.slice(0, MOUNT_LRU));

  const activeAgent = agents.find((a) => a.id === active);
  const cycleSession = (dir) => {
    const next = nextCycledSession(agents, active, dir);
    if (next) setActive(next);
  };

  return (
    <Box sx={(t) => ({ ...glass(t), position: 'relative', zIndex: getTokens(t).layers.content, flexShrink: 0, height: dockMin ? 'auto' : dockH, mx: 1.5, mb: 1.5, mt: dockMin ? 1.5 : 0, borderRadius: `${getTokens(t).radius.lg}px`, overflow: 'hidden', display: 'flex', flexDirection: 'column' })}>
      <Stack direction="row" spacing={1} role="button" tabIndex={0} onClick={toggleDock} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDock(); } }} title={dockMin ? 'Restore' : 'Minimize'} sx={(t) => ({ px: 1.5, height: 36, flexShrink: 0, display: 'flex', alignItems: 'center', cursor: 'pointer', userSelect: 'none', borderBottom: dockMin ? 'none' : `1px solid ${getTokens(t).glass.stroke}` })}>
        <SmartToyIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
        <Typography variant="subtitle2" sx={{ flex: 1 }} noWrap>Sessions</Typography>
        {dockMin ? <ExpandMoreIcon sx={{ fontSize: 18, color: 'text.secondary' }} /> : <ExpandLessIcon sx={{ fontSize: 18, color: 'text.secondary' }} />}
      </Stack>

      {/* Body kept mounted while minimized (display:none) so terminals keep
          their live xterm + scrollback. */}
      <Box sx={{ display: dockMin ? 'none' : 'flex', flex: 1, minHeight: 0 }}>
        <List sx={(t) => ({ width: listW.width, flexShrink: 0, overflow: 'auto', px: 1, py: 0.5, borderRight: `1px solid ${getTokens(t).glass.stroke}` })}>
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
              onDuplicate={() => { sendMsg({ t: 'create', cwd: a.cwd, name: nextSessionName(agents, a), model: a.model, scopes: a.scopes }); expandDock(); }}
              onFork={() => sendMsg({ t: 'fork', id: a.id, name: nextSessionName(agents, a) })}
              onRespawn={() => sendMsg({ t: 'respawn', id: a.id })}
              onReattach={() => sendMsg({ t: 'reattach', id: a.id })}
              onKill={() => sendMsg({ t: 'kill', id: a.id })}
            />
          ))}
        </List>

        {/* Drag handle — resize the session-list width. */}
        <ResizeHandle onMouseDown={listW.startDrag} />

        {/* Selected terminal. All non-detached terminals stay mounted
            (display:none when hidden) so scrollback + WS attach survive. */}
        <Box sx={{ position: 'relative', flex: 1, minWidth: 0, p: 0.5 }}>
          {agents.filter((a) => a.status !== 'detached' && mountedSet.has(a.id)).map((a) => {
            const show = !dockMin && a.id === active;
            return (
              <Box key={a.id} sx={{ position: 'absolute', inset: 0, display: show ? 'block' : 'none' }}>
                <Terminal agent={a} visible={show} sendMsg={sendMsg} onSwitch={cycleSession} registerOutput={(fn) => registerTerminal(a.id, fn)} />
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
  );
}
