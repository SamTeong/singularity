# Brag Plan: Singularity

## What is this app?
Singularity is a local-only web control plane for a whole fleet of coding agents — live PTY sessions, a kanban board where every card is a real git worktree + branch + agent session, scheduled/background jobs, and 5h/7d usage meters, all served from 127.0.0.1 with no cloud in the loop.

## The angle
The project's own problem statement is the joke and the pitch at once: *one terminal was fine, then there were seven.* Everyone running coding agents has lived this — sessions multiplying, branches drifting, reviews waiting in windows you forgot were open. The video stages the chaos for two seconds, then answers it with a real control deck: a task card becoming a worktree, an agent working the branch, a meter counting the spend, a card landing in DONE. Tactical, cinematic, phosphor-terminal — not a SaaS card grid.

## Hook (first 2-3 seconds)
Black screen, one blinking mint cursor. A line types itself: **ONE TERMINAL WAS FINE.** Then hard-cut orange: **THEN THERE WERE SEVEN.** — as six more cursor prompts flick on around it. The viewer recognises their own machine in under three seconds.

## Key moments (the middle)
- The **SINGULARITY** wordmark resolving out of scanline noise, 特異点 set above it, mint on near-black, with the one-line claim underneath.
- A **task card being created** on the kanban and carrying a real worktree ref — `singularity · task/a860e379` — as it moves TODO → IN PROGRESS. The card *is* the branch.
- The **live session terminal**: model banner, the agent thinking, and the statusline slamming in with real numbers — `04 turns · 42k/1.0m · $0.17 · 5h 19% · 7d 33%`.
- The **usage meters** filling in the rail (Claude 5h/7d, Ollama 5h/7d) beside the terminal — cost is a first-class citizen, not an invoice surprise.
- The card landing in **DONE** with its `complete` chip.

## Outro / punchline
Cut back to a bare terminal. Three lines type out: `git clone`, `cd singularity`, `pnpm bootstrap`. Under them: **127.0.0.1:4317 · YOUR MACHINE · YOUR STATE · YOUR AGENTS.** The joke lands quietly — the answer to seven terminals is one more terminal command.

## User flow worth showing
Entry → key action → result, as the product actually runs it:
1. **Entry** — open the deck: Tasks board live, Sessions dock below, usage meters in the rail.
2. **Key action** — `+ Task` creates a card; the daemon cuts a git worktree + branch + agent session for it; the card moves to IN PROGRESS and a live agent session starts working it.
3. **Result** — the session reports turns/tokens/cost on the statusline, the meters move, and the card lands in DONE with `complete`.

## Tone
- Preset: cinematic
- Creative direction: a live command environment booting — tactical, restrained, technically literal
- Interpretation: wide frames, big condensed type, few elements per frame and long enough holds to read them. Motion is precise and mechanical (scanline wipes, snap-ins, counter ticks), never bouncy. Confidence comes from showing real refs and real numbers, not from adjectives.

## Format: landscape — 1920x1080
## Duration: 21 seconds

## Visual identity (from the project)
- Background: `#0A0A0A` (deck `--bg`)
- Accent: `#52F29A` mint (`--mint`), highlight `#7CF4AB`, dim `#246C3C` / map `#3C9C6C`
- Alarm / chaos accent: `#F26400` orange, `#E2280F` red-hi
- Cool data accents: `#0C6C80` teal, `#5090D0` blue, `#F49F09` amber
- Text: `#52F29A` on `#0A0A0A`; paper `#EDF8D6` for rare high-contrast moments
- Display font: Arial Narrow / Avenir Next Condensed (`--cond`), uppercase, wide letter-spacing
- Body font: ui-monospace / SF Mono / Menlo / Consolas (`--mono`); JP accents in a Mincho serif (`--jp`)
- Strongest visual element: the phosphor terminal — mint monospace on near-black, thin `--green-dim` hairline borders, tabular numerals, a blinking block cursor, and the kanji eyebrow (統合 / 混沌 / 制御 / 開始)

## Share copy (draft)
One terminal was fine. Then there were seven. Singularity is a local control plane for your whole fleet of coding agents — sessions, worktree-backed tasks, usage, all on 127.0.0.1.

## Audio direction
- Role: cinematic support — a low, confident bed that carries the reveal and gets out of the way of the terminal beats.
- Music: `happy-beats-business-moves-vol-12-by-ende-dot-app.mp3` (109.96 BPM), started at 0.00s.
- Music treatment: quick fade-in over the hook (bed sits under the typing, ~0.35 gain), lift to full at the wordmark reveal, hold through the flow, fade out over the last 1.2s so the final command line lands nearly dry.
- Music cue guidance: preset cue file read (`assets/music/cues/…vol-12….music-cues.md`). Target strong cues — **8.74s** (task card commits to IN PROGRESS), **13.11s** (statusline slam), **17.47s** (TAKE CONTROL title). Beat grid ≈0.545s for sequential accents; sequential *text* reveals snap to every other beat (~1.09s) so each line clears its reading floor.
- Audio-reactive treatment: subtle — music RMS may drive the phosphor bloom/glow of the mint hairlines and the scanline sweep intensity only. No waveform bars, no bouncing chrome.
- SFX posture: sparse-to-moderate, strictly motion-matched. Keyboard ticks under typed text, one dry interface click on the `+ Task` press, a soft card/slide cue per card move, one low impact on the wordmark reveal, one short confirm on the `complete` chip.
- Audio-coupled moments: typed hook line, typed install command, the `+ Task` click, card → IN PROGRESS and card → DONE slides, the token/cost counters ticking up, the 5h/7d meters filling.
- Restraint rule: no risers, no whooshes on every cut, no stingers on text that is merely fading. At most one accent per beat; the terminal should sound like a terminal, not a trailer.

## Storyboard

### Scene 1 — CHAOS DETECTED — 3.8s
Full-black frame. A single mint block cursor blinks at a bare `>` prompt, dead centre-left. Tiny kanji eyebrow top-left: `混沌 CHAOS DETECTED`. Line one types out in condensed caps, mint: **ONE TERMINAL WAS FINE.** (holds ~1.3s). Hard cut: six more faint prompt panes flick on around the frame in a staggered burst, each with its own blinking cursor, and line two slams in orange: **THEN THERE WERE SEVEN.** (holds ~1.4s). Frame stays near-empty; the panes are hairline-bordered `--green-dim` rectangles, not a collage.
Sequential/interaction: yes — line one types character by character; the six extra terminal panes flick on one by one over ~0.6s on the beat grid; line two slams (no typing).
Audio intent: unease building under a dry, quiet room — the bed enters low and the multiplying panes make it feel like a problem getting away from you.
Audio-coupled idea: keyboard ticks on the typed line; a short dry interface blip per pane flick-on; no stinger on the orange slam beyond a single low hit.
Music: cinematic, low and restrained (bed at reduced gain).
Transition mood: dramatic — scanline wipe down to black → Scene 2

### Scene 2 — SINGULARITY — 3.4s
Near-black. A horizontal scanline sweep resolves the wordmark out of noise, centred: 特異点 small above, then **SINGU**·**LARITY** in huge condensed caps (mint, with `LARITY` in the highlight mint). One line under it, mono, letter-spaced: **ONE CONTROL PLANE FOR YOUR WHOLE FLEET OF CODING AGENTS.** (holds ~1.8s — 10 words, needs its floor). Eyebrow top-left ticks over to `統合 LOCAL AGENT OPERATIONS`.
Sequential/interaction: none — one composed reveal. The sub-line fades up 0.4s after the wordmark settles.
Audio intent: the answer arrives — bed lifts to full, the frame feels like it exhaled.
Audio-coupled idea: one low impact on the wordmark resolve, aligned to a strong beat; nothing else.
Music: cinematic, full gain from here.
Transition mood: clean — cut → Scene 3

### Scene 3 — THE BOARD IS THE BRANCH — 5.6s
The control deck. Left rail with the Singularity mark and the usage meters; centre is the Tasks kanban with four hairline columns: TODO · IN PROGRESS · IN REVIEW · DONE. Eyebrow: `制御 FLEET CONTROL`. A cursor moves to the top-right **+ Task** button and presses it; a card materialises in TODO reading **"Add Hooks page"** with the sub-ref `singularity · task/7063d43a`. A thin caption types beside it: **EVERY CARD IS A GIT WORKTREE.** (holds ~1.4s). On the strong cue at ~8.74s the card slides decisively into IN PROGRESS and its ref line lights mint. Beneath the board, the Sessions dock strip lights up with one entry: `7fe813ab · running`.
Sequential/interaction: yes — simulated cursor click on `+ Task`; card spawn, then card slide TODO → IN PROGRESS on the strong cue; the caption types; the sessions dock entry pops last.
Audio intent: mechanical confidence — every action makes a real, small, satisfying sound. The product is doing work.
Audio-coupled idea: one dry interface click on the button press; a card-slide cue on the column move; light key ticks under the typed caption; a soft pop on the session entry.
Music: cinematic, full — card move lands on the 8.74s strong cue.
Transition mood: clean — push-in toward the Sessions dock → Scene 4

### Scene 4 — LIVE AGENT, LIVE COST — 4.2s
Push into the terminal pane. Real session chrome: `Claude Code v2.1.218 · Opus 4.8 (1M context)`, a `>` prompt, a dim `✳ Cogitated for 4s` line. On the strong cue at ~13.11s the statusline slams in along the bottom in mono with tabular numerals, segments arriving left to right: `04 turns` · `42k/1.0m` · `$0.17` · `5h ▓▓░░ 19%` · `7d ▓▓▓░ 33%` — the token and dollar figures tick up rather than appearing finished. Simultaneously in the left rail the Claude and Ollama 5h/7d meter bars fill. Then the frame pulls back a touch and the card lands in **DONE** with a green `complete` chip. No caption text in this scene — the numbers are the copy.
Sequential/interaction: yes — statusline segments arrive one per beat; counters tick; four meter bars fill in sequence; card → DONE last.
Audio intent: proof. Dry, precise, quietly impressive — the sound of instrumentation, not celebration.
Audio-coupled idea: faint counter ticks under the rising numbers; one short confirm on the `complete` chip; segment arrivals share a single quiet accent, not four.
Music: cinematic, full — statusline slam on the 13.11s strong cue.
Transition mood: dramatic — scanline wipe to black → Scene 5

### Scene 5 — TAKE CONTROL — 4.0s
Back to a bare black terminal frame with a `--green-dim` hairline border. Eyebrow: `開始 TAKE CONTROL`. Title snaps in on the ~17.47s strong cue: **TAKE CONTROL**. Below it, three mono lines type out on every other beat, each holding after it lands:
`git clone https://github.com/SamTeong/singularity.git`
`cd singularity`
`pnpm bootstrap`
Final line fades up under them, letter-spaced mono: **127.0.0.1:4317 · YOUR MACHINE · YOUR STATE · YOUR AGENTS.** Cursor blinks once and holds on the last frame.
Sequential/interaction: yes — three typed command lines, one per every-other-beat (~1.09s apart) so each clears its reading floor; the closing line fades, it does not type.
Audio intent: settle and land — the bed fades out under the last line so the final beat is almost dry.
Audio-coupled idea: key ticks under the typed commands; one final soft cursor/enter tick, then silence.
Music: cinematic, fading out over the last ~1.2s.
Transition mood: soft — hold on black

**Music mood for this video:** cinematic
**Audio summary:** A low, restrained bed enters under the typing chaos, lifts to full on the wordmark reveal, carries the deck sequence with sparse motion-matched interface and card sounds locked to the 110 BPM grid, and fades out under the final typed install command so the last frame lands nearly dry.

---

**Scene duration check:** 3.8 + 3.4 + 5.6 + 4.2 + 4.0 = **21.0s** ✓ (15–25s)
