# History page — daily work timeline

> Status: **P1 (backend) done** (`8ffc85b`), **P2 (frontend) done** (`d227619`), **P3 (review) done** (`d109733`), **P4 (concurrent-backfill spend bug) done** (`1f910d5`), plus a blocking backend guard (`fe16ea3`). Suite 282 pass / 0 fail. Feature is code-complete. **P5 is next — live verification against the real daemon on :4317, which still predates P1 and has no `/history` route.** See "P5" at the bottom for the copy-paste kick-off.

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
- `POST /history/regenerate` `{date}` → `{ok, entry}` (400 when `date` missing); re-summarizes one day, atomic rewrite, emits `history`.

### As-built — P1 (read this before writing the frontend)

`server/history.mjs` exports: `localDay(ts)`, `readHistory()`, `scanDays(windowStart, root?)`, `buildDigest(sessions)`, `summarizeDay(digestText, sessions, {callAnthropic, callOllama}?)`, `ensureHistory({days, callAnthropic, callOllama, root}?)`, `regenerateDay(date, opts?)`, `liveToday(root?)`.

Entry shape on the wire is the JSON above, plus:
- `llm.reason` is `'trivial'` (day under 3 assistant turns, no LLM call), `'unavailable'` (every rung failed), or `'empty'` (**gap day** — no sessions at all: `summary:''`, `topics:[]`, `sessions:[]`, `metrics.sessions:0`). Render `'empty'` as the compressed gap segment, not as a card and not as an error.
- `llm.dropped` — array of session titles cut by the 48k digest cap, present only when something was dropped.
- `today` (from `liveToday()`) has `{date, live:true, repos, sessions, metrics}` and **no** `summary`/`topics`/`llm`.
- `sessions[]` rows are `{id, project, cwd, source, title, turns}` — exactly the fields `setOpenTx` needs, except `mtime` (pass `Date.now()` or omit).
- `pending` drains to `[]` once backfill finishes; gap days leave it (they get an `'empty'` entry). A date can be pending on first load and resolve over the WS `history` event, which carries `{entries, pending}` — full replacement, not a delta.

Deviations from this plan, deliberate:
- Optional `root` param threaded through `scanDays`/`ensureHistory`/`regenerateDay`/`liveToday` (default `undefined`, production call shapes unchanged). Tests need it or they scan the machine's real `~/.claude/projects` and the trivial-day gate goes flaky.
- Gap days **are** persisted (as `'empty'`) so they drain out of `pending` instead of shimmering forever, and stay re-checkable — rescanned on later calls, never re-appended while still empty, upgraded if the day turns out to have work.

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

## Kick-off prompt (copy-paste)

> Read `plan.md` in the repo root. P1 (backend) is done and committed (`8ffc85b`) — read the "As-built — P1" section for the real route/entry shapes and don't change the backend. Implement **P2 (frontend)** exactly as specified: `web/src/features/history/HistoryView.jsx` (+ co-located children if needed), `pnpm add framer-motion`, and the two wiring edits in `web/src/shell/AppMenu.jsx` / `AppShell.jsx`. Do not re-litigate the locked decisions table or the motion inventory — both were settled. Delegate the implementation to a `senior-software-engineer` subagent on sonnet to keep main-thread context small; that agent must load the `emil-design-eng`, `frontend-design`, and `impeccable` skills **before** writing any JSX. Before it starts, re-derive the motion inventory once with an agent that loads `emil-design-eng` + `animation-vocabulary` and reconcile it against the table in the plan. Then run P3: `review-animations` on the frontend diff, `reviewer` (or `cavecrew-reviewer`) on the whole diff. Commit P2 and any P3 fixes separately.

## Phase order

**P1 — backend. DONE** (`8ffc85b`): `server/history.mjs`, `callMessages` in `server/chat.mjs`, two routes in `server/index.mjs`, `history` forwarder in `server/pty-ws.mjs`, `history` branch in `web/src/providers/AgentsProvider.jsx`, `/history` in the Vite proxy, `server/history.test.mjs` (9 tests). Suite: 281 pass / 0 fail.

**P2 — frontend.** `web/src/features/history/HistoryView.jsx` (+ any co-located child components), `framer-motion` added via `pnpm add framer-motion`, and the two wiring edits in `AppMenu.jsx` / `AppShell.jsx`. The implementing agent must load `emil-design-eng`, `frontend-design`, and `impeccable` **before** writing any JSX, and self-check against the motion inventory table with `review-animations`.

Consume from P1, do not rebuild: `GET /history?days=7` for the initial fetch, `history` from `useAgents()` (`{entries, pending}`, full replacement on each WS push — merge by preferring the WS payload over the fetched one), `POST /history/regenerate {date}` for the regenerate control. Verification steps 2–7 below are P2's acceptance test.

**P3 — review. DONE** (`d109733`): `review-animations` + `cavecrew-reviewer` in parallel on sonnet. Eight of nine findings taken.

Correctness fixes: arrow-key nav stranded focus on gap days and unresolved placeholders (neither renders a focusable header, so `moveFocus` queued a `focusDate` that never resolved) — now walks past them; the range-change fetch had no staleness guard, so a slow response for an older range could stomp a newer one; the scrollspy never observed a day that resolved shimmer→card, because its effect key was the date list, which doesn't change on resolution.

Motion fixes: added the spec'd 60ms reveal stagger (absent entirely, capped at 8 cards); `popLayout` instead of `mode="wait"` on both `AnimatePresence` blocks, since "wait" fully exits before entering and turns a crossfade into a sequential swap with a blank frame; range-change split to the spec's asymmetric 200ms out / 290ms in; `layout="position"` on the card header so the parent's FLIP height animation translates its text instead of scale-stretching it; reduced-motion guard on the regenerate spinner; the feature's own `EASE_OUT` bezier in place of framer's weaker built-in `'easeOut'` string.

One finding **rejected**, ranked first by the animation reviewer: that framer's `y` shorthand is a GPU violation needing `useMotionTemplate`. Both write `style.transform` from JS in the same rAF batch — the distinction doesn't exist. Do not re-apply it.

**P4 — the concurrent-backfill spend bug.** Done (`1f910d5`). Shared in-flight promise in `ensureHistory`; body renamed `_ensureHistory`, otherwise untouched. One concurrency test added at the `-9 days` offset. Verified on a fresh isolated daemon: one `curl /history?days=7` → 7 lines / 7 unique dates, was 14.

## Delegation

Delegate P2 to a `senior-software-engineer` subagent on **sonnet** (`model: sonnet`), main thread stays triage/review only, per the review+fix orchestration pattern. That worked for P1: the subagent built it, the main thread caught two real bugs (gap days stuck in `pending` forever; a duplicated local-day string in the route) and fixed them before committing. Give the subagent explicit file scope and tell it not to commit.

## Traps found during recon — do not rediscover

- `STATE_DIR` comes from `server/app-dir.mjs`. There is **no** baked default; `~/.singularity` is not a valid path to hardcode. `SINGULARITY_HOME` must be set or `app-dir.mjs` throws.
- A new route **must** be added to `web/vite.config.mjs` `server.proxy` or dev-mode fetches fall through to the SPA shell and fail with "failed to load".
- Tests must set `SINGULARITY_HOME` before a **dynamic** `import()`; static imports hoist above the assignment and `app-dir.mjs` throws.
- The OAuth Messages endpoint requires the `system` field to begin with the exact Claude Code identity string. `chat.mjs` already handles this — reuse its constant, do not retype it.
- Ollama in this repo is a **launcher wrapper** (`ollama launch claude --model X -- …`), not a text-generation call. The fallback rung needs `ollama run <model> <prompt>` via `execFile`, which is new.
- `pnpm build` / `pnpm start` take ~20s warm and blow the default 120s tool timeout — run with `run_in_background`.
- Do not restart the daemon on :4317 if sessions are running inside it; probe with an isolated `SINGULARITY_HOME` + `PORT` daemon instead. **The running daemon predates P1** — it has no `/history` route until someone restarts it, so P2's fetch 404s against the live one; verify against a fresh isolated daemon.
- `history.test.mjs` cases share one `history.jsonl` and one fixture tree, so they are order-coupled by date (each case picks a distinct `-N days` offset on purpose). Adding a case? Pick an unused offset.
- `scanDays` is unscoped by default (`listSessions({cap:5000})` over the real root). Any new test touching it must pass `root`, or it sweeps in this machine's live sessions.
- The daemon requires a token when `.env` sets `SING_TOKEN` — an isolated probe daemon needs `SING_TOKEN=` (empty) in its env, or every request 401s.
- Two more traps found during P2, both fixed, both worth not re-introducing: session rows with `cwd: null` crash `parseSession` (see `fe16ea3`), and framer writes `transform` inline, so a CSS `:hover`/`:active` transform on a `motion` element never fires — put it on an inner element.

---

# P4 — concurrent backfill double-summarizes every day

**Status: DONE (`1f910d5`).** Found during P2 verification. Not blocking — the page renders correctly — but it doubles LLM spend on every cold start, which the plan's own "spend guards" decision exists to prevent.

## Symptom

After one cold start of a fresh daemon, `STATE_DIR/history.jsonl` held **14 lines for 7 dates** — every date twice, with visibly *different* summary wording in each copy. Different wording is the proof: these are two independent LLM calls per day, not a duplicated write.

## Mechanism

`ensureHistory` is invoked twice on a cold start, and the two runs overlap:

1. `server/index.mjs:721` — boot, fire-and-forget (`ensureHistory().catch(…)`).
2. `server/index.mjs:693` — the first `GET /history`, which the page issues on mount (`ensureHistory({ days }).catch(…)`).

`ensureHistory` (`server/history.mjs:256`) computes its work set up front:

```js
const prior = new Map(readHistory().map((e) => [e.date, e]));
const missing = wanted.filter((d) => d !== today && (!prior.has(d) || prior.get(d).llm?.reason === 'empty'));
```

Both callers reach that `readHistory()` before either has appended anything, so both derive the **same** `missing` set and both summarize it end to end.

`enqueueWrite` / `writeChain` (`server/history.mjs:68-76`) does not help. It serializes the *writes* so they cannot interleave and corrupt each other — which is all it was built for and all its comment claims. The unprotected critical section is wider than one write: it is read-diff → summarize → append.

Why it looks fine anyway: `readHistory` is last-wins per date, so the UI shows the second summary and never sees the duplication. The file just grows at 2× and the haiku bill doubles.

## Fix

Dedupe *callers*, don't widen the write lock. One shared in-flight promise, so a second concurrent `ensureHistory` joins the first instead of starting its own pass:

```js
let inFlight = null;
export async function ensureHistory(opts = {}) {
  if (inFlight) return inFlight;              // ponytail: joins the running pass; a
  inFlight = _ensureHistory(opts)             // wider `days` arriving second is picked
    .finally(() => { inFlight = null; });     // up by the next call, which is fine —
  return inFlight;                            // the route re-checks gaps on every load.
}
```

Rename the existing body to `_ensureHistory` and leave it otherwise untouched.

Known ceiling, name it in the comment: a second caller asking for a **wider** `days` window than the pass already running gets the narrower result. Harmless here because `GET /history` re-checks gaps on every load, so the wider window backfills on the next request. Do not build a request-merging queue for this.

## Test

Add to `server/history.test.mjs`, respecting its existing conventions — pick an **unused** `-N days` offset (the cases are order-coupled by date on purpose) and pass `root` so `scanDays` doesn't sweep the machine's real `~/.claude/projects`:

> Two `ensureHistory` calls fired concurrently (`await Promise.all([ensureHistory(o), ensureHistory(o)])`) make **one** LLM call per missing date and append **one** line per date. Assert on a call-counting `callAnthropic` stub, and on the line count of `history.jsonl` — not just on `readHistory()` length, which last-wins would make pass either way.

## Verify

1. `pnpm test` — expect 282 pass / 0 fail.
2. Fresh isolated daemon (`SING_TOKEN=` empty, scratch `SINGULARITY_HOME`, `PORT=4399` — **do not restart :4317**), then `curl /history?days=7` once and wait for backfill to finish. `wc -l` on `history.jsonl` must equal the number of closed days in the window, not twice it.

## As built

- `server/history.mjs`: body renamed `_ensureHistory` (logic untouched); new exported `ensureHistory` wrapper holds one module-level `inFlight` promise, cleared in `.finally`. The `ponytail:` comment names the ceiling — a wider `days` arriving second gets the narrower result, picked up by the next call because `GET /history` re-checks gaps on every load. No request-merging queue.
- `server/history.test.mjs`: one case at the `-9 days` offset (everything through `-7` is already on disk once the gap-day test's `days: 7` run finishes), `root: SESSIONS_ROOT`, 3 assistant turns so it clears the trivial gate. Asserts the `callAnthropic` stub fired once **and** the raw line count for the date is 1 — `readHistory().length` alone passes either way because the reader is last-wins.
- Verified: `pnpm test` 282 pass / 0 fail; isolated daemon (scratch `SINGULARITY_HOME`, `PORT=4399`, `SING_TOKEN=` empty, :4317 untouched) → one `curl /history?days=7` → `history.jsonl` 7 lines / 7 unique dates.

## Kick-off prompt (used — kept for the record)

> Read the **P4** section of `plan.md` in the repo root. Implement exactly that: the shared in-flight promise in `server/history.mjs`, plus the one concurrency test in `server/history.test.mjs`. Backend only — do not touch `web/`. P1/P2/P3 are done and committed; do not revisit them, and do not re-apply the rejected `useMotionTemplate` finding noted under P3. This is a small, well-specified change: do it inline, no subagent. Verify with the two steps in P4's Verify list, then commit. Note the traps list above — especially that the isolated probe daemon needs `SING_TOKEN=` empty, and that `history.test.mjs` cases are order-coupled by date offset.

---

# P5 — live verification + e2e coverage

**Status: DONE (`1270d7e`).** Both gaps closed — the page was driven against a live :4317 daemon that serves `/history`, and the e2e spec was added. (Was: the feature was code-complete after P1–P4, 282 pass / 0 fail, but the page had never been driven against a daemon that serves `/history` — every prior check was a unit test or a `curl` at an isolated probe daemon.)

1. **The daemon on :4317 predates P1.** It has no `/history` route, so the History page 404s against the live instance. It needs a restart — but sessions run inside it, so that restart is the user's call, not an agent's. Do not restart it unattended.
2. **No e2e spec.** `e2e/` covers every other page (`nav`, `transcripts`, `usage`, `tasks`, …); there is no `history.spec.mjs`. The suite drives a throwaway sandbox daemon, so a History spec needs a seeded `history.jsonl` rather than live LLM calls.

## Work

- Get :4317 restarted (ask the user), then load the History page and confirm end-to-end: entries render newest-first, gap days render absence instead of shimmering forever, unresolved days stream in over WS, expand → session list → deep-link into Transcripts, Regenerate rewrites one day in place, range switch animates without a blank frame.
- Add `e2e/history.spec.mjs` in the shape of the existing specs. Seed `history.jsonl` into the sandbox `SINGULARITY_HOME` via `e2e/fixtures/seed.mjs` — the sandbox daemon must **never** backfill for real; an unseeded run fires live haiku calls per missing day. Cover: seeded days render, expand → sessions, deep-link out, gap-day copy.

## Traps that still apply

The "Traps found during recon" list above is all still live. The two that bite here: the sandbox/probe daemon needs `SING_TOKEN=` empty or every request 401s, and `SINGULARITY_HOME` has no default — unset means `app-dir.mjs` throws.

## Kick-off prompt (copy-paste)

> Read the **P5** section at the bottom of `plan.md` in the repo root (`c:\git\singularity`), plus the "Traps found during recon" list above it. Implement exactly that, nothing else.
>
> Two halves, in this order:
>
> 1. **Live verification.** The daemon on :4317 predates P1 and has no `/history` route, so the page 404s against it. Sessions run inside that daemon — **do not restart it yourself**. Ask me first and say what you need. Once it serves `/history`, walk the page: newest-first order, gap days rendering absence instead of shimmering forever, unresolved days streaming in over WS, expand → session list → deep-link into Transcripts, Regenerate rewriting one day in place, range switch with no blank frame. Report what you actually observed, per item — do not report a step as verified if you could not run it.
> 2. **`e2e/history.spec.mjs`.** Follow the existing specs (`e2e/transcripts.spec.mjs` is the closest analogue). Seed `history.jsonl` into the sandbox `SINGULARITY_HOME` through `e2e/fixtures/seed.mjs`; the sandbox daemon must **never** backfill for real, since an unseeded run fires live haiku calls per missing day. Cover: seeded days render, expand → sessions, deep-link out, gap-day copy.
>
> P1–P4 are done and committed (`8ffc85b`, `d227619`, `d109733`, `1f910d5`, plus the guard `fe16ea3`). Do not revisit them. In particular do not re-apply the P3 finding that framer's `y` shorthand needs `useMotionTemplate` — it was reviewed and rejected, and the reason is recorded under P3.
>
> Verify: `pnpm test` (needs `--test-force-exit`; the suite does not self-exit) stays at 282 pass / 0 fail, and the new e2e spec passes. Then commit.

## As built

- `e2e/history.spec.mjs` (new, 4 tests): seeded days render newest-first; expand → session list (`role="region"` "Sessions"); deep-link into Transcripts (asserts the transcript content rendered, not just the view switch — `openHistorySession` carries no `title`, so the header shows the raw id); gap day renders the absence hairline (`[aria-label*="no work"]`), zero `[aria-busy="true"]` shimmers.
- `e2e/fixtures/seed.mjs`: `seedHistory()` writes 7-day `state/history.jsonl` (6 non-empty + 1 `llm.reason:'empty'` gap at day-2). Fixture transcripts backdated to 2025-06-01, outside any 7-day window, so `scanDays` finds nothing even if `ensureHistory` runs.
- `e2e/serve.mjs`: sandboxed `CODEX_HOME` (nonexistent path). Unset, `listCodexSessions()` scanned the real `~/.codex` and leaked 130+ live Codex transcripts into the sandbox; `scanDays` found them in the backfill window and would have upgraded the seeded gap day and fired real haiku via the real OAuth token. Also fixed the Transcripts view showing 162 sessions (32 fixture + 130 real) instead of 32. This trap is NOT in the "Traps found during recon" list above — `listSessions` calling `listCodexSessions` with no root and no sandbox isolation was undiscovered until P5.
- Live verification on :4317 (user restarted; agent never restarted it): all six checklist items confirmed — newest-first (6 Aug → 30 Jul); gap day 2026-07-11 renders the absence hairline `aria-label="…, no work"` (not observable in 7d, confirmed in the authorized one-time 30d switch); WS `history` frames on Regenerate (1) and 30d backfill (23); expand 2026-08-05 → 43 session rows → deep-link mounts Transcripts + transcript content; Regenerate on 2026-07-30 rewrote the summary in place (spinner → new text, same DOM position, no blank frame); 7d→30d range switch crossfaded via `popLayout` with the card count never dropping to 0. The 30d switch fired 22 real haiku calls (one-time, user-authorized).
- Verified: `pnpm test` 282 pass / 0 fail; `e2e/history.spec.mjs` 4 pass. A full `pnpm test:e2e` run had 13 failures in unrelated specs (editors/config/explorer/create-dialogs) — all UI timeouts from live-session contention on the shared machine, not caused by the P5 diff; the new history spec passed in that same run.
