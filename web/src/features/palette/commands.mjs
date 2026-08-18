import { VIEW_LIST } from '@/shell/views.mjs';
import { isCodexModel } from '@/lib/models.js';
import { nextSessionTitle } from '@/lib/sessionTitle.js';
import { isLive } from '@/lib/agentStatus.js';

// Build the Views command group from the unified view catalog (shell/views.mjs,
// shared with the router so palette entries and valid routes cannot drift).
// Phase 0: Views group. Phase 1: Sessions group (switch/fork/respawn/reattach/kill/external/transcript).

// `isWorking` mirrors SessionRow.jsx's own row-action gating (isLive now comes
// from the canonical home in agentStatus.js) so a command only appears in the
// palette when the matching button would show in the dock.
const isWorking = (s) => s === 'running' || s === 'starting';

// Sessions group: one 'New Session' entry + per-agent ops, gated exactly like
// SessionRow's row actions (fork hides for codex, respawn needs live, reattach
// needs detached, external hides while working — kill/transcript always show).
function buildSessionCommands(ctx) {
  const cmds = [{
    id: 'session:new',
    group: 'Sessions',
    label: 'New Session',
    keywords: ['create', 'session'],
    hint: 'session',
    run: () => ctx.onNewSession(),
  }];
  for (const a of ctx.agents) {
    const title = a.title || a.id.slice(0, 8);
    const codex = a.tool === 'codex' || isCodexModel(a.model);
    if (a.status !== 'detached') {
      cmds.push({
        id: 'session:switch:' + a.id,
        group: 'Sessions',
        label: title,
        keywords: [a.tool, a.cwd?.split(/[\\/]/).pop()].filter(Boolean),
        hint: 'session',
        run: () => { ctx.setActive(a.id); ctx.expandDock(); },
      });
    }
    if (!codex) {
      cmds.push({
        id: 'session:fork:' + a.id,
        group: 'Sessions',
        label: 'Fork ' + title,
        hint: 'session',
        run: () => ctx.sendMsg({ t: 'fork', id: a.id, title: nextSessionTitle(ctx.agents, a) }),
      });
    }
    if (isLive(a.status)) {
      cmds.push({
        id: 'session:respawn:' + a.id,
        group: 'Sessions',
        label: 'Respawn ' + title,
        hint: 'session',
        run: () => ctx.sendMsg({ t: 'respawn', id: a.id }),
      });
    }
    if (a.status === 'detached') {
      cmds.push({
        id: 'session:reattach:' + a.id,
        group: 'Sessions',
        label: 'Reattach ' + title,
        hint: 'session',
        run: () => ctx.sendMsg({ t: 'reattach', id: a.id }),
      });
    }
    cmds.push({
      id: 'session:kill:' + a.id,
      group: 'Sessions',
      label: 'Kill ' + title,
      hint: 'session',
      run: () => ctx.sendMsg({ t: 'kill', id: a.id }),
    });
    if (!isWorking(a.status)) {
      cmds.push({
        id: 'session:external:' + a.id,
        group: 'Sessions',
        label: 'Open ' + title + ' in external terminal',
        hint: 'session',
        run: () => fetch('/api/session/external', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: a.id }),
        }).catch(() => {}), // ponytail: no toast reachable from the palette
      });
    }
    cmds.push({
      id: 'session:transcript:' + a.id,
      group: 'Sessions',
      label: 'Transcript of ' + title,
      hint: 'session',
      run: () => ctx.viewTranscript(a),
    });
  }
  return cmds;
}

export function buildCommands(ctx) {
  const viewCmds = VIEW_LIST.map((x) => ({
    id: 'view:' + x.v,
    group: 'Views',
    label: x.label,
    keywords: [x.v],
    hint: 'view',
    run: () => ctx.setView(x.v),
  }));
  return [...viewCmds, ...buildSessionCommands(ctx)];
}
