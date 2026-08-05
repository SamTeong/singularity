# History page — daily work timeline

> Status: **planned, not started.** No code written. See "Next session" at the bottom.

## Context

Singularity surfaces *live* agent state (Tasks, Transcripts, Usage) but nothing answers "what did I actually get done last week?". Transcripts exist per-session, are named by first prompt, and are unreadable in bulk. Two harnesses now write them (`~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/rollout-*.jsonl`), so the record is split.

This adds a **History** page under the More menu: one entry per calendar day, LLM-summarized from that day's transcripts, persisted to `STATE_DIR/history.jsonl` so summarization happens once per day and the archive grows. The page renders it as a vertical scroll-driven descent — newest day at the surface, scrolling drills backwards through time — and each day expands into its constituent sessions, deep-linking to the existing Transcripts view.

Scope is **harness transcripts only**. No git log, no project folders.

## Decisions already locked (from clarification round)

| Question | Decision |
|---|---|
| Summary generation | LLM per missing day (haiku) |
| Source of truth | `~/.claude` + `~/.codex` transcripts only — not project folders, not git commits |
| Rebuild trigger | Daemon boot **and** lazy on page load |
| Visual direction | Vertical scroll-driven descent, newest at top |
| LLM input | User prompts + assistant closing messages |
| Backfill depth | 7 days; today live-only, never persisted |
| Day bucketing | Per-message, machine-local time |
| Day card carries | Volume metrics + cost ($) + harness split + topics/projects |
| Motion tech | framer-motion (approved new dependency) |
| Backfill UX | Async, stream in over WS, placeholders resolve in place |
| Spend guards | Skip trivial days; record summary's own cost; degrade if claude absent; **fall back to ollama `glm-5.2:cloud`** on absence or usage limit |
| Drill-down | Expand to sessions + deep-link to Transcripts page |
| Regenerate | Yes — atomic rewrite of the file |

## What already exists (reuse, do not rebuild)

| Need | Existing | Where |
|---|---|---|
| Enumerate claude + codex sessions, one merged reverse-chrono list | `listSessions({cap, root})` → rows `{id, project, cwd, title, mtime, size, source, file, subagents}` | `server/sessions.mjs:294` |
| Read one session into `{ok, meta, messages[]}`, both harnesses, messages carry `ts` | `readSession(project, id, root, source, file)` | `server/sessions.mjs:434` |
| **LLM call — Anthropic Messages API on the Claude Code OAuth token, free on subscription** | `streamChat` + `claudeOauthToken()`; header block, 401/429 handling, `IDENTITY` prefix requirement all already solved | `server/chat.mjs`, `server/usage.mjs` |
| Authoritative per-session USD | `readCostFile(id)` → `cost.total_cost_usd` | `server/stats.mjs` |
| Per-session turns/tokens | `parseSession(cwd, id, tool)`, `(mtime,size)`-keyed cache | `server/stats.mjs:58` |
| JSONL append | `appendJsonl(file, record)` pattern | `server/usage.mjs` |
| Atomic whole-file write | `reg.writeAtomic(file, str)` | `server/agents.mjs`, used by `crons.mjs:23` |
| WS fan-out | `reg.bus.emit(type, payload)` → forwarder in `attachPtyWs` → `{t:'<type>', …}` → `AgentsProvider` `onmessage` | `server/pty-ws.mjs:38-65`, `web/src/providers/AgentsProvider.jsx:63` |
| Transcript deep-link | `setOpenTx({project, id, cwd, source, mtime}); setView('sessions')` | `web/src/shell/AppShell.jsx:171` |
| `glm-5.2:cloud` already a known model | `OLLAMA_PRESETS` | `server/models.mjs:7` |

**Key finding: no `claude -p` subprocess, no pty, no `CLAUDE_BIN` dependency for summarization.** `chat.mjs` already talks to the Messages API directly with the OAuth token — that is the summarizer.

## Data model — `STATE_DIR/history.jsonl`

One line per day, oldest→newest, `YYYY-MM-DD` in **machine-local** time.

```json
{"date":"2026-08-04","summary":"Shipped a VS Code-style file tree with a multi-tab editor, then hardened saves with a 409 stale-write guard after hitting races on refresh-on-focus.","topics":["explorer","editors","409-guard"],"repos":["singularity","other-repo"],"sessions":[{"id":"6fb6d4e…","project":"c--git-singularity","cwd":"c:\\git\\singularity","source":"claude","title":"add History page","turns":82}],"metrics":{"sessions":4,"turns":137,"tokens":812000,"costUsd":2.41,"byHarness":{"claude":{"sessions":3,"turns":125},"codex":{"sessions":1,"turns":12}}},"llm":{"ok":true,"provider":"anthropic-oauth","model":"claude-haiku-4-5-20251001","inputTokens":18240,"outputTokens":96},"builtAt":"2026-08-05T09:12:04.881Z"}
```

Reader: parse every line, **last-wins per `date`** — so an appended regenerate still reads correctly and a partially-rewritten file degrades to "older summary wins" rather than corruption. Writer: append for new days; `reg.writeAtomic` for regenerate. Both writes go through one in-module promise chain so boot backfill and a regenerate cannot interleave.

## Backend — `server/history.mjs` (new)

### Bucketing
Per-**message**, machine-local (`toLocaleDateString('en-CA')` → `YYYY-MM-DD`, no manual TZ math). A session crossing midnight contributes its messages to both days and appears in both days' `sessions[]`.

Cost cannot be split per message — `readCostFile` is whole-session. **Prorate by that day's share of the session's assistant turns**, with a `ponytail:` comment naming the approximation.

### Day scan
1. `listSessions({cap: 5000})`, filter `mtime >= windowStart` (a session last touched before the window cannot contribute to it).
2. `readSession` each survivor (already cached in `sessions.mjs`), bucket its messages by local day, accumulate metrics via `parseSession` / `readCostFile`.
3. Result: `Map<date, dayAggregate>`.

### Digest fed to the LLM
**User prompts + assistant closing messages.** New reducer (~15 lines) over `readSession().messages` — `sessionText()` is *not* reusable here, it emits everything including tool traffic.

Per session, per day: header line (`cwd`, harness, turn count), every `role:'user'` `kind:'text'` message truncated to 400 chars, then the **last** `role:'assistant'` `kind:'text'` message truncated to 800. Skip `kind:'thinking'` and all tool entries. Hard-cap the assembled digest at **48k chars**, dropping lowest-turn sessions first, and record what was dropped in the entry.

### Summarizer + fallback chain
`summarizeDay(digest)`, non-streaming, in order:

1. **Anthropic Messages API** — export a non-streaming `callMessages({system, messages, maxTokens})` from `chat.mjs`, reusing its exact headers, `IDENTITY` prefix, and model const; call it from `history.mjs`. Additive change only; `streamChat` untouched. Ask for strict JSON `{summary, topics}`; `max_tokens: 400`.
2. **On 401 / 429 / network failure → ollama.** `execFile(OLLAMA_BIN, ['run', 'glm-5.2:cloud', prompt])`, promisified as in `procs.mjs:20`, `maxBuffer` 8MB, 120s timeout. This is a **new invocation form** — existing ollama use (`agents.mjs:373`) is `ollama launch claude …`, a launcher wrapper, not text generation. Absent `OLLAMA_BIN` → skip this rung.
3. **Deterministic** — `"N sessions across <repos>"` plus the longest session titles; `llm.ok:false`, so a later regenerate can upgrade it.

Guards: skip the LLM entirely for a day under **3 assistant turns** (deterministic one-liner, `llm.ok:false, reason:'trivial'`); record the summarizer's own token counts in `llm`.

### Backfill
`ensureHistory({days = 7})` — diff wanted days against dates already in the file, summarize missing ones **oldest→newest, sequentially** (one API call in flight), appending each and emitting `reg.bus.emit('history', …)` after each so the UI fills in progressively. Called once from `index.mjs` at boot (fire-and-forget, never blocks listen) and again on `GET /history` when the requested range has gaps.

**Today is never persisted** — computed live per request from the day scan, no LLM, marked `live:true`.

### Routes (`server/index.mjs`)
- `GET /history?from&to` (or `?days=7`, default) → `{ok, entries:[…newest first], pending:[dates], today}`; kicks off backfill for gaps, returns immediately.
- `POST /history/regenerate` `{date}` → re-summarizes one day, atomic rewrite, emits `history`.

### WS
`reg.bus.emit('history', {entries, pending})` → new forwarder in `pty-ws.mjs` alongside the `crons` one → `{t:'history', …}` → new branch in `AgentsProvider.jsx` `onmessage`. No initial `send` on connection (the page fetches).

### Also required
`/history` added to `web/vite.config.mjs` `server.proxy` — otherwise dev on :5317 falls through to the SPA and the fetch throws (per CLAUDE.md).

## Frontend — `web/src/features/history/`

`framer-motion` added to `package.json` dependencies (approved; pnpm 11.15.0, React 19.2).

### Concept
**A core sample.** The left spine is a stratigraphic column; each day is a stratum whose *thickness and density* encode volume. Today is the surface, scrolling drills down. You read depth before you read numbers.

### Layout
- Spine: 56px fixed gutter, `position: sticky`. A 2px rule with a bright "drill head" marker tracking scroll progress; day ticks sized by volume. The **date label is sticky and hands off** — the current day's label pins at the top of the gutter until the next day's tick pushes it out.
- Cards: `max-width: 720px`, left-aligned against the spine, 24px gap.
- **Visual weight from metrics**: card min-height scales with turns (88px → 220px, `sqrt` so a 10× day isn't 10× tall); a density band along the card's leading edge with opacity from token count; harness split as a two-tone segment on that band (claude / codex).
- Today's card: distinct treatment — live metrics, no summary, a slow breathing pulse on the drill head only.
- **Gap days** (no work): not omitted — a compressed 20px spine segment with a hairline and no card. Absence is information.

### Motion inventory

| Effect (term) | Trigger | Property | Duration | Curve | Impl |
|---|---|---|---|---|---|
| Staggered reveal / slide-fade up | card enters viewport | `opacity`, `transform: translateY(16px) scale(.985)` | 420ms, 60ms stagger | `cubic-bezier(.16,1,.3,1)` | framer `whileInView`, `viewport={{once:true, margin:'-10% 0px'}}` |
| Scroll-linked spine progress | scroll | `transform: scaleY` on the rule, `translateY` on the drill head | position-driven | linear | framer `useScroll` + `useTransform`, `useSpring({stiffness:180, damping:30})` |
| Sticky-label handoff | scroll | `opacity` + `translateY` crossfade of gutter date labels | 180ms | `ease-out` | CSS `position:sticky` + framer `AnimatePresence` |
| Parallax depth | scroll | `translateY` on the density band, ~0.94× rate | position-driven | linear | framer `useTransform` |
| Hover lift | pointer enter | `transform: translateY(-2px)`, `box-shadow` | 160ms | `ease-out` | CSS (cheaper than a framer subscription per card) |
| Expand / accordion reveal | click | `height:auto` + child `opacity`/`translateY` | spring | `{stiffness:320, damping:34, mass:.9}` | framer `motion.div` `animate={{height:'auto'}}`, `AnimatePresence` |
| Placeholder shimmer | pending day | `background-position` on a gradient | 1.6s loop | linear | CSS (must not be a JS loop) |
| **Placeholder → resolved** | WS `history` event | crossfade text + `layout` height settle | 320ms | `{stiffness:260, damping:30}` | framer `layout` prop + `LayoutGroup` |
| Range-change re-render | date-range commit | exit `opacity`/`translateY(-8px)`, enter as reveal | 200ms out / 420ms in | `ease-in` / `ease-out` | framer `AnimatePresence mode="popLayout"` |

`box-shadow` on hover is the one non-compositor property animated — one element at a time, on a `will-change`-free card. Nothing else touches layout-triggering properties.

### Curiosity mechanic
Click a day → the card expands in place to reveal its `sessions[]` (title, repo, turns, harness diamond). Rows stagger in at 40ms. Clicking a row calls an `onOpenSession` prop → `setOpenTx({project, id, cwd, source, mtime}) + setView('sessions')`, exactly as `AppShell.jsx:171` already does. The timeline becomes a front door to transcripts you would otherwise never revisit.

### Date range
Two native `<input type="date">` bound to the archive's min/max, plus preset chips (7 / 30 / All). No picker dependency.

### Performance
- Under 60 cards: plain render. Over: windowed render (slice by scroll offset against measured card heights) — **not** a virtualization library.
- `whileInView` with `once: true` so a card animates exactly once; no scroll listener per card.
- `LayoutGroup` + `layout` handles the placeholder→resolved height change; no manual measurement.
- No `will-change` left on idle elements. Cap concurrent reveals at ~8 via the stagger.

### Accessibility
`prefers-reduced-motion`: reveals become instant `opacity` only (no transform); spine progress becomes a static filled rule; expand becomes an instant height change; shimmer becomes a static tint; parallax off entirely.
Keyboard: cards are `<button>`-semantic, arrow keys move between days, `Enter`/`Space` expands, `Tab` enters the session list.
Screen reader: each day is an `<article>` with `aria-label="Monday 4 August 2026, 4 sessions, $2.41"`, the summary as body text, `aria-expanded` on the disclosure, `aria-busy="true"` while pending.

### Anti-slop bar
No table. No gradient-text headings. No `border-radius: 16px` glass card with a purple gradient. No emoji as icons. No centred hero. No three-column stat grid. Numbers in tabular-figures monospace, matching the existing terminal-adjacent pages. Type scale must contrast hard — summary prose at 15px/1.55, metrics at 11px uppercase tracked.

## Wiring
1. `web/src/shell/AppMenu.jsx:27` — add `{v:'history', icon:<TimelineIcon/>, label:'History'}` to `NAV_ITEMS`.
2. `web/src/shell/AppShell.jsx:34` — `const HistoryView = lazy(() => import('@/features/history/HistoryView.jsx'))`; render at ~L240 as `{view === 'history' && <HistoryView onOpenSession={…}/>}`. **Not** added to `PERSISTENT_VIEWS` — a mounted scroll-driven page paying `useScroll` costs while hidden is waste; remount is cheap.

## Tests — `server/history.test.mjs`
`SINGULARITY_HOME=<scratch temp>` set before a **dynamic** `import()` (per CLAUDE.md — static imports hoist above the env assignment). Fixtures as real JSONL under a temp claude-projects + codex-sessions root, LLM call injected as a stub:

1. Midnight-spanning session buckets into both days, and its cost prorates by assistant-turn share.
2. `ensureHistory` appends only missing dates, ascending, and is idempotent on a second run.
3. Reader is last-wins per date when a duplicate date line exists.
4. Trivial day (<3 assistant turns) writes `llm.ok:false, reason:'trivial'` and makes no LLM call.
5. LLM 429 → ollama stub → deterministic: each rung produces a valid entry and never throws.
6. Digest cap: an oversized day is truncated and records what was dropped.
7. Today is never written to the file.

## Verification
1. `pnpm test` — full suite (`--test-force-exit`; the suite does not self-exit).
2. `pnpm dev`, open `127.0.0.1:5317` → More → History. First load: 7 days, some resolved, the rest shimmering and filling in one at a time over WS. Confirm `STATE_DIR/history.jsonl` gained one line per closed day and today is absent from it.
3. Reload — instant, zero LLM calls (check daemon log).
4. Expand a day, click a session → lands on Transcripts with it open.
5. Set a range predating the archive → those days render as gaps, not errors.
6. DevTools Performance: scroll the full timeline, confirm no layout thrash and 60fps; toggle OS reduced-motion and confirm the degradations above.
7. Rename `~/.claude/.credentials.json` temporarily → confirm the ollama rung fires; also unset `OLLAMA_BIN` → confirm deterministic entries, `llm.ok:false`, no crash.

## Deliberate simplifications
- Cost proration by turn share, not true per-message attribution — `readCostFile` is whole-session only.
- Windowed render hand-rolled, no virtualization dep — threshold 60 cards.
- Regenerate rewrites the file; serialized against backfill by one in-module promise chain, no file locking.

---

# Next session — how to continue

## Kick-off prompt

> Read `plan.md` in the repo root. Implement Phase 1 (backend) exactly as specified. Do not re-litigate the locked decisions in the table — they were settled in a clarification round. Do not touch the frontend yet.

## Phase order

**P1 — backend.** `server/history.mjs`, the additive `callMessages` export in `server/chat.mjs`, the two routes in `server/index.mjs`, the `history` forwarder in `server/pty-ws.mjs`, the `history` branch in `web/src/providers/AgentsProvider.jsx`, `/history` in `web/vite.config.mjs` proxy, and `server/history.test.mjs`. Stop and run `pnpm test` before moving on.

**P2 — frontend.** `web/src/features/history/HistoryView.jsx` (+ any co-located child components), `framer-motion` added via `pnpm add framer-motion`, and the two wiring edits in `AppMenu.jsx` / `AppShell.jsx`. The implementing agent must load `emil-design-eng`, `frontend-design`, and `impeccable` **before** writing any JSX, and self-check against the motion inventory table with `review-animations`.

**P3 — review.** `review-animations` on the frontend diff, `cavecrew-reviewer` (or `reviewer`) on the whole diff. Commit per phase.

## Delegation

Delegate P1 and P2 to `senior-software-engineer` subagents (one per phase, sequential — P2 needs P1's route shape). Keep the main thread as triage/review only, per the review+fix orchestration pattern. Subagents were unavailable at planning time (safety classifier down); if the `Agent` tool still errors with *"claude-sonnet-5[1m] is temporarily unavailable"*, run the phases in the main thread instead.

## Traps found during recon — do not rediscover

- `STATE_DIR` comes from `server/app-dir.mjs`. There is **no** baked default; `~/.singularity` is not a valid path to hardcode. `SINGULARITY_HOME` must be set or `app-dir.mjs` throws.
- A new route **must** be added to `web/vite.config.mjs` `server.proxy` or dev-mode fetches fall through to the SPA shell and fail with "failed to load".
- Tests must set `SINGULARITY_HOME` before a **dynamic** `import()`; static imports hoist above the assignment and `app-dir.mjs` throws.
- The OAuth Messages endpoint requires the `system` field to begin with the exact Claude Code identity string. `chat.mjs` already handles this — reuse its constant, do not retype it.
- Ollama in this repo is a **launcher wrapper** (`ollama launch claude --model X -- …`), not a text-generation call. The fallback rung needs `ollama run <model> <prompt>` via `execFile`, which is new.
- `pnpm build` / `pnpm start` take ~20s warm and blow the default 120s tool timeout — run with `run_in_background`.
- Do not restart the daemon on :4317 if sessions are running inside it; probe with an isolated `SINGULARITY_HOME` + `PORT` daemon instead.
