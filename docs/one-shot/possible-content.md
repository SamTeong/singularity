# Singularity Product Page: Possible Content

This is a reusable content sourcebook for generating distinct Singularity product-page iterations. It separates verified product facts from optional story structures, interface copy, and visual prompts so a new page can feel original without inventing capabilities.

## 1. Product truth

### One-line definition

Singularity is a local web control plane for running and coordinating a fleet of coding agents across sessions, tasks, and git worktrees.

### Short product description

Singularity puts live agent terminals, task state, worktrees, automation, usage, history, configuration, and local system health in one browser interface. It is designed for spec-driven development when one terminal becomes many and the coordination work starts to eclipse the coding work.

### Category language

Prefer:

- Local agent control plane
- Coding-agent fleet console
- Spec-driven development cockpit
- Local operations layer for coding agents
- One operational record for parallel agent work

Avoid:

- Autonomous software company
- Cloud agent platform
- AI employee marketplace
- Universal IDE replacement
- Fully automatic code reviewer
- Enterprise orchestration platform

Those phrases claim more than the current repository demonstrates.

## 2. Audience, job, and tension

### Primary audience

Developers who already run multiple coding agents, terminals, branches, or worktrees and need to understand what is active, what is blocked, where a change lives, and what needs human attention.

### Job to be done

When several agents are changing the same repository in parallel, help me keep every task, worktree, session, transcript, and system signal attached to the work so I can intervene at the right moment without reconstructing state from scattered windows.

### Core tension

Code generation scales faster than human attention. The bottleneck moves from producing code to coordinating concurrent work.

### Pain signals

- Seven terminal tabs with names that no longer explain what is happening.
- A task exists in one place, its branch in another, and its agent transcript somewhere else.
- Parallel changes collide because isolation is informal.
- A stalled permission prompt is invisible behind another window.
- Usage limits appear only after momentum is lost.
- The reasoning behind yesterday's change is difficult to recover.
- Automation can start work, but no single surface shows the resulting processes.
- Project rules, hooks, skills, and memory are repeatedly rediscovered or repasted.

### Desired outcomes

- See the fleet before opening another terminal.
- Move from an intent to an isolated workstream with a durable chain of custody.
- Know which agents are running, waiting, blocked, or finished.
- Review the exact transcript and worktree behind a change.
- Keep operational state on the developer's machine.
- Preserve human control over launch, intervention, and review.

## 3. Message hierarchy

Use these messages in order unless an iteration deliberately chooses a narrower thesis.

1. **Coordination is now the bottleneck.** More agents create more concurrent state.
2. **Singularity makes that state visible.** Sessions, tasks, worktrees, terminals, and health share one control surface.
3. **Work keeps its chain of custody.** A spec becomes a task, worktree, branch, session, transcript, and reviewable change.
4. **The environment around the agent matters.** Automation, configuration, memory, usage, history, wiki, and processes are part of the job.
5. **The control plane is local.** The daemon binds to loopback and keeps its state under a local Singularity home.
6. **Start from the repository.** Bootstrap, start, and open the local interface.

## 4. Headline bank

### Coordination thesis

- Code is cheap. Coordination is the control surface.
- The agents are fast. The state around them is not.
- Your fleet can write in parallel. Can you review in context?
- More agents should not mean more archaeology.
- The code is moving. See where it is going.
- Stop managing a fleet through terminal tabs.

### Visibility thesis

- One live view of every agent, task, and worktree.
- See the whole fleet before you touch the wheel.
- The work is distributed. The operational record is not.
- Every running agent. One local deck.
- Know what is active, blocked, and ready for review.

### Workflow thesis

- Intent in. Isolated work out.
- From spec to review without losing the thread.
- Every task gets a branch, a worktree, and a trace.
- Work moves. Context stays attached.
- A durable chain of custody for agent-written code.

### Local-first thesis

- Your machine. Your state. Your control plane.
- Fleet control without moving the control plane to the cloud.
- Local agents deserve a local operations layer.
- Loopback by default. Human control throughout.

## 5. Hero combinations

### Hero A: The bottleneck

**Eyebrow:** LOCAL AGENT CONTROL PLANE / 局所制御系

**Headline:** CODE IS CHEAP. COORDINATION IS THE BOTTLENECK.

**Body:** Singularity turns a pile of terminals, branches, worktrees, and agent transcripts into one live operational record—running on your machine.

**Primary action:** INSPECT THE CONTROL PLANE

**Secondary action:** VIEW SOURCE

### Hero B: The fleet

**Eyebrow:** FLEET STATE / 艦隊状態

**Headline:** SEE THE WHOLE FLEET BEFORE YOU TOUCH THE WHEEL.

**Body:** Watch live sessions, dispatch isolated tasks, inspect terminal output, and recover the context behind every change from one local interface.

**Primary action:** ENTER THE COCKPIT

**Secondary action:** READ THE WORKFLOW

### Hero C: Chain of custody

**Eyebrow:** SPEC-DRIVEN DEVELOPMENT / 仕様駆動開発

**Headline:** FROM INTENT TO REVIEW WITHOUT LOSING THE THREAD.

**Body:** A task in Singularity stays connected to its worktree, branch, agent session, transcript, and review state.

**Primary action:** TRACE A TASK

**Secondary action:** BOOT LOCALLY

### Hero D: Local control

**Eyebrow:** LOOPBACK OPERATIONS / 環状運用

**Headline:** YOUR MACHINE. YOUR STATE. YOUR AGENTS.

**Body:** A browser-based fleet console backed by a loopback-only daemon, with optional token protection and local operational state.

**Primary action:** SEE THE ARCHITECTURE

**Secondary action:** OPEN GITHUB

## 6. Problem framing modules

### Module: Window sprawl

**Label:** BEFORE / 分散

Seven terminals. Four branches. Three waiting prompts. One developer reconstructing the map from memory.

The failure is not that the agents cannot write code. The failure is that their state has no shared surface.

Possible evidence labels:

- TERMINAL 07 — OWNER UNKNOWN
- BRANCH TASK/9E0B59D — AGENT DETACHED
- PROMPT WAITING — 11M 42S
- USAGE WINDOW — UNSEEN
- REVIEW CONTEXT — FRAGMENTED

### Module: Coordination tax

**Label:** HUMAN LOAD / 人間負荷

Every new agent adds another stream of execution. Without a control plane, the operator pays for that parallelism in tab switching, status checks, branch archaeology, and lost reasoning.

Possible counters:

- ACTIVE WINDOWS: 07
- STATE SOURCES: 12
- CONTEXT SWITCHES: 31/H
- SHARED VIEW: 00

These are illustrative interface data, not measured customer statistics. Present them as a scenario, never as benchmark results.

### Module: State fragmentation

**Label:** BROKEN CHAIN / 断線

`SPEC ≠ TASK ≠ BRANCH ≠ SESSION ≠ TRANSCRIPT ≠ REVIEW`

Singularity's product story is the transformation of that broken sequence into an inspectable chain.

## 7. Core workflow copy

### 01 — Spec / 仕様

Capture the intent and acceptance boundary before an agent starts changing files.

Interface evidence:

- `SPEC: LOCAL-USAGE-GAUGE`
- `ACCEPTANCE: 4/4 DEFINED`
- `RISK: LOW`

### 02 — Task / 任務

Turn the spec into a trackable unit of work with status, metadata, and an operator-visible queue position.

Interface evidence:

- `TASK: 9E0B59D`
- `STATUS: READY`
- `PRIORITY: P1`

### 03 — Worktree / 分岐

Create a dedicated git worktree and branch so parallel changes remain isolated.

Interface evidence:

- `PATH: .WORKTREES/9E0B59D`
- `BRANCH: TASK/9E0B59D`
- `BASE: MAIN`

### 04 — Agent / 実行

Launch the task session and watch the live terminal, process state, and usage signals from the same deck.

Interface evidence:

- `SESSION: SES-7F4A`
- `STATE: RUNNING`
- `PTY: ATTACHED`

### 05 — Review / 審査

Return to the change with its worktree and transcript still attached. Inspect what happened before deciding what happens next.

Interface evidence:

- `FILES: 06 CHANGED`
- `TESTS: 48 PASS`
- `DECISION: HUMAN REQUIRED`

## 8. Capability copy

| Capability | User outcome | Product proof surface | Safe short copy |
|---|---|---|---|
| Sessions | See and control live agent processes | Session list, xterm terminal, process status | Live agent terminals with durable session state. |
| Tasks | Coordinate spec-driven units of work | Kanban state, task metadata | Track work from backlog through active execution and review. |
| Worktrees | Isolate parallel changes | Task-linked path and branch | Give concurrent agents separate git worktrees and branches. |
| Automation | Start eligible work without manual polling | Cron and background job views | Schedule jobs or dispatch queued work in the background. |
| Usage | Anticipate limits and inspect consumption | Five-hour, seven-day, session views | Read fleet and per-session usage windows in one place. |
| Configuration | Keep runtime settings inspectable | Config editor and validation | Inspect and edit project or local configuration. |
| Hooks, skills, rules, memory | Keep reusable context discoverable | Dedicated configuration surfaces | Make the instructions around the agent visible and reusable. |
| History | Recover what happened on a given day | Daily activity view | Review completed work by day and session. |
| Transcripts | Recover the reasoning behind a change | Searchable local conversation archive | Inspect and resume past agent conversations. |
| Wiki | Navigate linked project knowledge | Wiki graph and document view | Browse repository knowledge without leaving the control plane. |
| Explorer | Inspect and edit repository files | File tree and editor | Keep repository context beside the running work. |
| Status | See provider and daemon health | Status dashboard | Check control-plane and provider availability. |
| Processes | Find running or stalled agents | Process table and controls | See every active agent process and its state. |

## 9. Feature-story modules

### Live fleet deck

**Headline:** One operational picture, updated while the work moves.

**Body:** Sessions, tasks, terminal output, usage, and system health sit in the same visual hierarchy. The operator can scan first, then drill into the stream that needs attention.

Suggested interface tabs:

- LIVE SESSIONS
- TASK QUEUE
- USAGE WINDOW
- SYSTEM STATUS

### Environment around the agent

**Headline:** The agent is one process. The product is everything around it.

**Body:** Configuration, hooks, skills, rules, memory, files, wiki pages, transcripts, and history are not secondary when the work spans hours or days. Singularity keeps those surfaces near execution.

### Automation with visibility

**Headline:** Background does not have to mean invisible.

**Body:** Cron jobs and eligible-task dispatch can start work while the fleet view keeps the resulting sessions and processes legible.

### Recoverable context

**Headline:** Yesterday's reasoning should be a record, not a memory test.

**Body:** History and transcripts let the operator return to prior work, inspect the conversation that produced it, and resume with the original context available.

### Operator observability

**Headline:** Know when to intervene.

**Body:** Usage windows, provider state, daemon health, process data, and live terminal output help distinguish healthy progress from a session waiting silently for a human.

## 10. Local-first and security copy

### Verified architecture statement

The Singularity daemon binds to `127.0.0.1`. The browser UI connects to that local service for HTTP and WebSocket operations. Runtime state is stored beneath `SINGULARITY_HOME`, and an optional `SING_TOKEN` can protect access.

### Architecture labels

```text
BROWSER UI
    ↓ HTTP + WEBSOCKET
127.0.0.1 · LOCAL DAEMON
    ├── AGENT PTYs
    ├── TASK + SESSION STATE
    ├── USAGE + HISTORY
    └── REPOSITORY WORKTREES
```

### Safe headline options

- Local means loopback.
- The control plane stays on the machine doing the work.
- A local operations layer for local agent processes.
- Inspectable state. Explicit access. No public bind by default.

### Guardrails

Do not say:

- “Zero data ever leaves your machine.” Agent providers may still receive prompts and code according to their own tooling.
- “Air-gapped.” The product can interact with external agent providers and repository remotes.
- “End-to-end encrypted.” That is not established by the repository.
- “Enterprise-grade security.” That requires a broader security claim than loopback binding and optional token protection.

## 11. Final call-to-action copy

### CTA A

**Headline:** Put the fleet on one screen.

**Body:** Clone the repository, bootstrap the workspace, and open the local control plane.

```bash
git clone git@github.com:SamTeong/singularity.git
cd singularity
pnpm bootstrap
pnpm start
```

### CTA B

**Headline:** Start where your agents already run.

**Body:** Singularity is a local repository project. Bootstrap it, start it, and bring the coordination layer up beside the work.

### CTA C

**Headline:** More execution. Less reconstruction.

**Body:** Give every agent session a visible place in the system before the next task enters the queue.

Primary link label options:

- OPEN THE REPOSITORY
- VIEW SOURCE ON GITHUB
- INSPECT SINGULARITY

Command action labels:

- COPY BOOT COMMAND
- COPY `PNPM BOOTSTRAP`
- COPY LOCAL SETUP

Repository: <https://github.com/SamTeong/singularity>

## 12. Realistic demo data

Use fictional operational records that demonstrate the interface without implying customer results.

### Sessions

| ID | Label | Branch | State | Signal |
|---|---|---|---|---|
| SES-7F4A | usage-gauge | task/9e0b59d | RUNNING | tests 48/48 |
| SES-2C91 | transcript-index | task/71ac03e | WAITING | permission required |
| SES-A8D0 | hooks-schema | task/b4802fa | COMPLETE | review ready |
| SES-11BE | wiki-links | task/08f14c2 | QUEUED | slot 04 |

### Terminal sequence

```text
[14:32:08] TASK 9E0B59D ATTACHED
[14:32:09] WORKTREE .WORKTREES/9E0B59D READY
[14:32:11] AGENT SESSION SES-7F4A STARTED
[14:32:27] READ src/pages/Usage.tsx
[14:33:02] PATCH usage window meter
[14:33:19] TEST 48 PASS · 0 FAIL
[14:33:21] STATE REVIEW_READY
```

### Usage data

- 5H WINDOW: 19%
- 7D WINDOW: 43%
- ACTIVE SESSIONS: 03
- QUEUED TASKS: 04
- PROVIDERS: 02/02
- DAEMON: NOMINAL

### Human decision queue

- `9E0B59D` — Review six changed files
- `71AC03E` — Approve requested file access
- `B4802FA` — Return for one failing edge case

## 13. Bilingual interface pairs

Use Japanese as secondary operational annotation, not as decorative pseudo-translation. Keep English primary for product comprehension.

| English | Japanese |
|---|---|
| Control | 制御 |
| Fleet | 艦隊 |
| Task | 任務 |
| Session | 会期 |
| Worktree / branch | 分岐 |
| Execution | 実行 |
| Review | 審査 |
| Status | 状態 |
| System | 系統 |
| Local | 局所 |
| Memory | 記憶 |
| History | 履歴 |
| Automation | 自動 |
| Warning | 警告 |
| Ready | 準備完了 |
| Human decision | 人間判断 |

## 14. Page narrative recipes

### Iteration 01 — Mission control

1. Fleet-scale hero
2. Terminal-sprawl problem
3. Interactive live cockpit
4. Spec-to-review pipeline
5. Surrounding systems grid
6. Loopback architecture
7. Boot command

Best when the page needs to demonstrate product breadth quickly.

### Iteration 02 — Coordination bottleneck

1. “Code is cheap” provocation
2. Streams of agent activity converging into operator load
3. A live chain-of-custody trace for one task
4. Human decision queue
5. Operational surfaces arranged around a central signal spine
6. Local control boundary
7. “More execution. Less reconstruction.” CTA

Best when the audience already uses multiple agents and needs the problem named precisely.

### Iteration 03 — One task, fully traced

1. A single incoming spec
2. Task creation
3. Worktree and branch isolation
4. Live agent session and terminal
5. Tests, transcript, and usage evidence
6. Human review decision
7. Zoom out to show the same chain repeated across the fleet

Best for a product demo page with a strong scroll-driven narrative.

### Iteration 04 — Local trust boundary

1. “Your machine, your state” hero
2. Browser-to-loopback architecture
3. What remains local and what is configurable
4. Optional access token and explicit boundaries
5. Processes, transcripts, history, and repository state
6. Fleet workflow
7. Local setup

Best for technical audiences skeptical of another hosted coordination layer.

### Iteration 05 — Operator decisions

1. The fleet runs in parallel
2. Three conditions that need a human: permission, review, failure
3. Inspect evidence without reconstructing context
4. Resolve the queue from the control plane
5. Automation continues healthy work
6. History preserves the decisions
7. Start locally

Best when emphasizing human-in-the-loop control rather than autonomy.

## 15. Interaction ideas

Every interaction should reveal product meaning rather than merely decorate the page.

- **Dispatch trace:** advance one task through spec, task, worktree, agent, and review; update the transcript and system counters together.
- **Session selector:** choose a session to replace terminal output, branch, usage, and status metadata.
- **Decision queue:** approve, hold, or return a simulated item; keep an ARIA live record of the decision.
- **Signal filter:** switch between fleet, work, context, and system layers.
- **Architecture probe:** focus each node to highlight only the connections crossing that boundary.
- **Copy command:** copy `pnpm bootstrap` and expose clear success/failure feedback.
- **Chapter rail:** indicate current reading position and allow keyboard navigation.
- **Live clock:** show local operator time; freeze it under reduced-motion preferences if continual updates are distracting.

Motion grammar:

- Use instant changes, linear motion, or `steps()`.
- Avoid spring, elastic, bounce, or eased presentation animation.
- Disable blinking, staged sequences, marquees, and nonessential transforms under `prefers-reduced-motion: reduce`.

## 16. Visual-content direction

The page should read like an operational artifact, not a generic SaaS landing page.

Use:

- Near-black field
- Orange structural rails, dividers, coordinates, and chrome
- Mint for nominal or active state
- Blue for queued or informational state
- Amber for terminal output and attention
- Red only for critical state
- Double frames, chamfered corners, dense labels, stamps, segmented meters
- Condensed uppercase display type plus monospace operational text
- Japanese Mincho annotations paired with clear English copy
- CRT scanlines and vignette across the full viewport
- Tables, traces, terminals, topology maps, and state transitions as proof

Avoid:

- Generic rounded cards
- Gradient glows
- Floating decorative blobs
- Three equal feature cards beneath a centered hero
- Invented dashboards with metrics that look like customer results
- Testimonials, logos, pricing, or unsupported integrations

## 17. Claim checklist

Before publishing an iteration, verify that it does not imply any of the following unless the repository changes:

- Hosted SaaS deployment
- Multi-user collaboration or role-based access control
- Pull-request creation or merge automation
- Support for a named agent provider not explicitly shown in current code or docs
- Remote fleet control across machines
- Guaranteed privacy of third-party provider traffic
- Benchmarked productivity gains
- Enterprise support, SLAs, pricing, or customer adoption

Safe claims should map to a visible repository surface, command, configuration option, or documented architecture behavior.

## 18. Copy-paste generation brief

Use the block below to prompt a future page iteration.

```text
Create a standalone responsive Singularity product page using the Jairus OS / NERV-MAGI design system.

Narrative recipe: [choose one from Section 14]
Primary headline: [choose or adapt from Section 4]
Primary proof interaction: [choose one from Section 15]

The page must describe Singularity as a local control plane for coding-agent fleets. It may show sessions, tasks, git worktrees, live terminal output, automation, usage, configuration, hooks, skills, rules, memory, history, transcripts, wiki, status, and processes. The core workflow is spec → task → worktree → agent → review. The daemon binds to 127.0.0.1, supports an optional SING_TOKEN, and stores local state beneath SINGULARITY_HOME.

Use only verified claims from this sourcebook. Do not add testimonials, pricing, customer metrics, hosted collaboration, cloud fleet control, named integrations, or claims that all data stays local.

Visual requirements: near-black surface; orange structural chrome; semantic mint, blue, amber, and red; condensed and monospace typography; bilingual JP/EN pairs; double frames; chamfers; stamps; segmented meters; terminal rows; and a mandatory CRT overlay. Use hard corners and mechanical state transitions.

Interaction requirements: semantic landmarks, logical headings, keyboard-operable controls, visible focus, ARIA live feedback, 44px mobile targets, and a stable reduced-motion mode. Include a copy action for pnpm bootstrap and link to https://github.com/SamTeong/singularity.

Deliver one self-contained HTML file with embedded CSS, JavaScript, SVG, or canvas and no external assets or dependencies. Verify at 375px, 768px, 1024px, and 1440px.
```

## 19. Source references

When refreshing this file, check these repository sources before adding or changing claims:

- Root `README.md` for positioning, setup commands, and product surfaces.
- `apps/daemon/src/server.ts` for loopback host behavior and service routes.
- `apps/daemon/src/config.ts` for `SINGULARITY_HOME` and `SING_TOKEN` behavior.
- `apps/web/src/App.tsx` and page routes for current product surfaces.
- `packages/types` and task/session stores for state terminology.

Treat realistic task IDs, branches, timestamps, and terminal lines in this document as fictional demo data—not telemetry or customer evidence.
