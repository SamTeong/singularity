# Singularity — Implementation Plan (Handoff)

> **Status:** ✅ Complete — all 6 phases built (plus a bonus Claude-process task manager). Backends verified headlessly; UI views screenshotted. Interactive acceptance gates confirmed by the user. See `README.md` to run.
> **Deferred:** scrollback is a **256 KB per-agent in-memory ring** (see `RING_MAX` in `server/agents.mjs`), not the 5 MB on-disk ring described below — disk-backed scrollback (`logs/<id>.log`) is Phase 3, not yet built.
> **Interactive visual version:** https://claude.ai/code/artifact/90de38bf-f2cf-4d9b-b369-4c4a807e7c93

## Context

There is no UI to run and manage multiple Claude Code agents on this Windows machine — each agent today is a manual terminal. Singularity is a **local web app** (browser UI + a long-lived Node daemon) that:

1. Spins up live `claude` agent sessions in chosen repos, steerable interactively.
2. Survives restarts (reattach to running agents).
3. Edits Claude Code harness `settings.json` (3 scopes) and searches/edits memory files — all from one place.

Explicitly **not a CLI app**.

## Locked decisions (do not re-litigate)

| Area | Decision |
|---|---|
| App shape | Local web app: browser UI + Node daemon, loopback-only |
| Exec model | Interactive PTY sessions via `node-pty` (not headless `-p`, not Agent SDK) |
| Interaction | Full live steering — type into agents, interrupt, approve tool calls |
| Layout | Sidebar agent list + main terminal pane |
| Agent cwd | Per-agent repo/dir picker (+ recent-repos list) |
| Config editor | Full editor across user / project / project-local `settings.json` |
| Persistence | Reattach on restart |
| Frontend | Vite + React + xterm.js + CodeMirror |
| Location | `C:\git\singularity` |

## Confirmed environment (verified on this machine)

- `node` v24.16.0, `claude` 2.1.207, platform win32 x64.
- `claude` CLI flags that matter:
  - `--session-id <uuid>` — launch with an app-chosen UUID (**the key to reattach**).
  - `-r, --resume [value]` — resume a conversation by session id.
  - `-n, --name <name>` — display name (shown in prompt box / `/resume` picker / terminal title).
  - `--output-format stream-json` — only with `--print` (not used here; we run interactive).
- Spawned `claude` **auto-inherits** `~/.claude` harness config + existing auth — **no auth code needed**.
- Interactive sessions log to `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. `<encoded-cwd>` is the abs path with separators replaced by `-` (e.g. `C--git-myapp`). These `.jsonl` files are parseable for per-agent cost/turns.

## Architecture

```
Browser (React)  ──HTTP──▶  Daemon (Node / Fastify)     REST: config, memory, agent CRUD
  xterm.js       ──WS────▶     node-pty registry          WS:  pty I/O, resize, status
  CodeMirror                   disk scrollback logs
                                      │ spawns
                                      ▼
                             claude CLI child (per agent)
                               --session-id <uuid> (app-owned)
                               inherits ~/.claude harness + auth
```

**Security (non-negotiable):** daemon binds `127.0.0.1` **only**. It spawns arbitrary `claude` agents with full filesystem access and can bypass permissions — must never bind `0.0.0.0`. Add an optional loopback token in Phase 6.

## Backend design — `server/` (Node, Fastify + `ws` + `node-pty`)

**Agent registry:** in-memory `Map<id, Agent>`, persisted to `agents.json` in an app-data dir.

```js
Agent = {
  id,          // uuid — IS the claude --session-id
  name,        // display name
  cwd,         // working dir; determines project config + memory scope
  status,      // 'starting' | 'running' | 'idle' | 'detached' | 'exited'
  pid,
  createdAt,
  logPath,     // <appdata>/logs/<id>.log
}
```

**Spawn:**
```js
pty.spawn('claude', ['--session-id', id, '--name', name], { cwd, cols, rows, env: process.env })
```

**WebSocket protocol:**
- client → server: `create{cwd,name}`, `attach{id}`, `input{id,data}`, `resize{id,cols,rows}`, `kill{id}`
- server → client: `output{id,data}`, `status{id,status}`, `list{agents}`

**Scrollback log (Phase 3 — not yet built):** append raw pty output to `<appdata>/logs/<id>.log`, **ring-capped at N MB (default 5 MB; surface the cap in the UI — no silent truncation)**. On `attach`, stream the file tail, then live output. *Current implementation: a 256 KB per-agent in-memory ring only; nothing is written to disk and the cap is not surfaced in the UI.*

**Reattach (the hard part — Windows has no tmux; leverage Claude Code's own session persistence):**
- Browser refresh = re-attach WS + replay ring buffer. Instant, because the daemon still holds the pty.
- Daemon/machine restart = ptys are gone. On daemon start, load `agents.json`, mark each agent `detached` (do **not** auto-spawn — mass respawn is expensive). A **Reattach** button runs `claude --resume <id>` in the same `cwd` → restores the actual conversation (not just terminal text) + replays the in-memory scrollback ring above the fresh TUI. Auto-reattach = opt-in toggle.

## Config editor — REST `/config`

- `GET /config?cwd=<dir>` resolves 3 scopes and returns content + `exists` for each:
  - user: `~/.claude/settings.json`
  - project: `<cwd>/.claude/settings.json`
  - project-local: `<cwd>/.claude/settings.local.json`
- `PUT /config/:scope` → JSON-parse + validate → **write a `.bak` first** → write.
- **User-scope guardrail:** on this machine `~/.claude/settings.json` is a junction into git-tracked `~/.agents`. In the UI, make user scope **read-only by default** with an explicit "edit anyway" toggle and a warning that edits mutate versioned shared config.

## Memory — REST `/memory`

- Memory lives per-project: `~/.claude/projects/<encoded-cwd>/memory/*.md` plus a `MEMORY.md` index.
- `GET /memory/search?q=` → grep across all project memory dirs; label each result by project.
- `GET /memory/file?path=` / `PUT /memory/file` → read/write, **path-guarded to memory dirs only**.

## Frontend — `web/` (Vite + React)

- **Layout:** left sidebar = agent list (name, cwd, status dot; later cost/turns); main pane = selected agent's xterm.js terminal with full live steering (keystrokes → `input`, `ResizeObserver` → `resize`).
- **Create-agent modal:** dir picker (browse + recent-repos list persisted in `agents.json`) + name field.
- **Config tab:** scope switcher (user / project / local) + CodeMirror JSON editor with settings-schema lint + save (writes `.bak`) + user-scope guardrail.
- **Memory tab:** search box → results list → CodeMirror markdown editor.

## File layout to create (representative)

```
server/
  index.mjs      # Fastify bootstrap, 127.0.0.1 bind, serve built web/
  agents.mjs     # registry, spawn/kill/reattach, agents.json persistence
  pty-ws.mjs     # WS handler + node-pty wiring + scrollback ring/log
  config.mjs     # 3-scope resolver, backup-then-write, junction guardrail
  memory.mjs     # search + guarded file read/write
web/             # Vite React app
  App.jsx  Sidebar.jsx  Terminal.jsx  ConfigEditor.jsx  MemoryPanel.jsx
package.json     # root
README.md
```

## Build phases (sequential; each has an acceptance gate)

1. **Prove the hard tech (RISK GATE — build first).** Daemon + WS + node-pty + one xterm; live-steer one `claude` session in a fixed cwd end-to-end.
   *Accept:* spawn agent in a test repo, type a prompt, see the streamed response, approve a tool call.
   *Validates:* node-pty native build on node 24 / win-x64, and ConPTY + alt-screen TUI rendering in xterm.js — the two highest risks.
2. **Multi-agent.** Sidebar list, create-with-cwd-picker, status dots, kill, `agents.json` persistence.
   *Accept:* run 3 agents in different repos, switch between them, kill one, list survives restart of the browser.
3. **Reattach.** UUID ownership, disk scrollback logging, detach → reattach via `--resume`.
   *Accept:* kill the daemon mid-session, restart it, click Reattach → conversation resumes, scrollback intact.
4. **Config editor.** 3-scope resolver, CodeMirror + schema lint, backup + user-scope guardrail.
   *Accept:* edit project-local `settings.json` → `.bak` written + valid; user-scope edit triggers the guardrail.
5. **Memory.** Cross-project search + guarded editor.
   *Accept:* search a known term, open + edit a memory file, write is confined to the memory dir.
6. **Polish.** Loopback token; parse each session `.jsonl` for per-agent cost/turns in the sidebar; run script / packaging.

## Risks & mitigations

- **node-pty native build (node 24 / win-x64).** Latest is `node-pty` 1.1.0. Pin it (ships prebuilds); fallback `@homebridge/node-pty-prebuilt-multiarch`; document `npm rebuild`. Prove in Phase 1.
- **ConPTY + full-screen TUI.** `claude` uses alt-screen ANSI; xterm.js handles it, but test resize/redraw early (Phase 1).
- **`--resume` redraw.** A resumed session redraws a fresh TUI, not the old pixels. The in-memory scrollback ring is shown above it; the conversation itself is restored. Acceptable — document in the UI.

## Verification (end-to-end)

- Phase 1 acceptance (above) is the go/no-go gate for the whole build.
- Reattach: daemon kill → restart → Reattach resumes conversation via `--resume`.
- Config: project-local edit writes `.bak` + valid file; user-scope guardrail fires.
- Memory: search + edit, write scoped to memory dir.
- Security: `netstat` confirms daemon on `127.0.0.1` only, not `0.0.0.0`.

## Cost reference

Per-phase execution estimate (historical p50/p90 on this machine): **p50 $0.76 / p90 $3.30**. Six phases ≈ **$5–20** total.
