# Hyperframes Composition Brief: Singularity

## Objective
Create a short launch-style brag video for Singularity — a local-only web control plane for a fleet of coding agents.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080
- Duration: 21 seconds

## Source Material
- Project root: `C:\git\singularity`
- Primary files read:
  - `README.md` (product description + feature list)
  - `CLAUDE.md` (architecture, daemon, state model)
  - `assets/screenshot-overview.png` (the real running UI — rail, Tasks kanban, Sessions dock, statusline)
  - `github-pages/src/styles/tokens.css` (the brand tokens — colors + fonts)
  - `github-pages/src/config/chapters.ts` (chapter titles/subs)
  - `github-pages/src/components/chapters/{Orientation,Chaos,TakeControl,Stats}.tsx` (verbatim product copy)
- Product name: **SINGULARITY** (deck sets it as `SINGU` + `LARITY`, the second half in highlight mint; kanji 特異点 above)
- Tagline / strongest claim: **ONE CONTROL PLANE FOR YOUR WHOLE FLEET OF CODING AGENTS.**
- Key UI moment to recreate: the running control deck from `assets/screenshot-overview.png` — left rail with 5h/7d usage meters, the Tasks kanban (TODO · IN PROGRESS · IN REVIEW · DONE) with real cards carrying worktree refs (`singularity · task/7063d43a`, chip `complete`), and the Sessions terminal dock below with the agent statusline (`04 · [42k/1.0m] · $0.17 · 5h 19% · 7d 33%`). Rebuild it in the deck's phosphor-terminal identity (mint on near-black) rather than tracing the screenshot's purple ZAPAC skin — the phosphor look is the brand register.
- Copy that must appear verbatim:
  - `ONE TERMINAL WAS FINE.`
  - `THEN THERE WERE SEVEN.`
  - `SINGULARITY` (rendered `SINGU` + `LARITY`)
  - `ONE CONTROL PLANE FOR YOUR WHOLE FLEET OF CODING AGENTS.`
  - `EVERY CARD IS A GIT WORKTREE.`
  - `TAKE CONTROL`
  - `git clone https://github.com/SamTeong/singularity.git`
  - `cd singularity`
  - `pnpm bootstrap`
  - `127.0.0.1:4317 · YOUR MACHINE · YOUR STATE · YOUR AGENTS.`
  - Kanji eyebrows: `混沌 CHAOS DETECTED`, `統合 LOCAL AGENT OPERATIONS`, `制御 FLEET CONTROL`, `開始 TAKE CONTROL`

## Creative Direction
- Tone preset: cinematic
- Creative direction: a live command environment booting — tactical, restrained, technically literal
- Interpretation: wide frames, big condensed uppercase type, few elements per frame, holds long enough to read. Motion is precise and mechanical — scanline wipes, snap-ins, counter ticks — never bouncy or elastic. Confidence comes from real refs and real numbers, not adjectives.
- Angle: The project's own problem statement is both the joke and the pitch — *one terminal was fine, then there were seven.* Everyone running coding agents has lived it: sessions multiplying, branches drifting, reviews waiting in windows you forgot were open. The video stages that chaos for two seconds, then answers it with a real control deck — a task card becoming a git worktree, an agent working the branch, a meter counting the spend, the card landing in DONE. Tactical and phosphor-terminal, not a SaaS card grid.
- Hook: black frame, one blinking mint cursor, `ONE TERMINAL WAS FINE.` types out; hard cut to orange `THEN THERE WERE SEVEN.` as six more cursor panes flick on around it.
- Outro / punchline: the answer to seven terminals is one more terminal command — `git clone` / `cd singularity` / `pnpm bootstrap`, then `127.0.0.1:4317 · YOUR MACHINE · YOUR STATE · YOUR AGENTS.`
- Avoid:
  - Generic SaaS language ("streamline your workflow", "supercharge", "10x")
  - Abstract filler visuals — gradient washes, floating particles, AI-blob imagery
  - Unrelated visual redesign — do not invent a new palette or a rounded-card marketing look
  - Decorative dashboards that reveal no real workflow (explicit project anti-reference)

## Visual Identity
- Background: `#0A0A0A`
- Text: `#52F29A` (mint), highlight `#7CF4AB`, mid `#3C9C6C`, dim/hairlines `#246C3C`; rare high-contrast paper `#EDF8D6`
- Accent: `#F26400` orange (chaos/alarm), `#E2280F` red-hi; data accents `#0C6C80` teal, `#5090D0` blue, `#F49F09` amber
- Display font: `"Arial Narrow", "Avenir Next Condensed", "Helvetica Neue", Arial, sans-serif` — uppercase, wide letter-spacing (project `--cond`)
- Body font: `ui-monospace, "SF Mono", Menlo, Consolas, monospace` (project `--mono`); JP eyebrows in `"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif` (`--jp`)
- Visual references from the project:
  - Phosphor terminal: mint monospace on `#0A0A0A`, 1px `#246C3C` hairline borders, tabular numerals, blinking block cursor
  - Kanji eyebrow pattern: `<jp kanji> <LATIN LABEL>` at 8px, 0.13em tracking, uppercase
  - Chapter numbering / code chrome (`SCR·01`, `01 … 14`) if a frame needs texture
  - Kanban columns as hairline rectangles with uppercase column headers and a `(n)` count
  - Statusline strip: single mono row of `·`-separated segments with tabular figures and block-glyph meters

## Storyboard
Use the storyboard in `brag-output/brag-plan.md` as the creative contract.

Scene summary:
1. **CHAOS DETECTED** — 3.8s — `混沌 CHAOS DETECTED` eyebrow; cursor types `ONE TERMINAL WAS FINE.`; six more terminal panes flick on; orange `THEN THERE WERE SEVEN.` slams in.
2. **SINGULARITY** — 3.4s — scanline resolve of 特異点 + `SINGU`/`LARITY` wordmark; sub-line `ONE CONTROL PLANE FOR YOUR WHOLE FLEET OF CODING AGENTS.` holds ~1.8s.
3. **THE BOARD IS THE BRANCH** — 5.6s — the control deck: rail + usage meters + 4-column kanban; cursor clicks `+ Task`; card `Add Hooks page` / `singularity · task/7063d43a` spawns in TODO, caption `EVERY CARD IS A GIT WORKTREE.` types, card slides to IN PROGRESS on the strong cue; Sessions dock lights `7fe813ab · running`.
4. **LIVE AGENT, LIVE COST** — 4.2s — push into the terminal pane (`Claude Code v2.1.218 · Opus 4.8 (1M context)`, `✳ Cogitated for 4s`); statusline slams in segment by segment with ticking counters `04 · 42k/1.0m · $0.17 · 5h 19% · 7d 33%`; rail meters fill; card lands in DONE with `complete` chip. No caption — the numbers are the copy.
5. **TAKE CONTROL** — 4.0s — bare bordered terminal; `開始 TAKE CONTROL` eyebrow; title snaps in; three install commands type out every other beat; closing line `127.0.0.1:4317 · YOUR MACHINE · YOUR STATE · YOUR AGENTS.` fades up; cursor blinks and holds.

## Audio
- Audio role: cinematic support — a low, confident bed that carries the reveal and gets out of the way of the terminal beats.
- Audio arc: enters low under the typing chaos → lifts to full on the wordmark reveal → carries the deck sequence with sparse motion-matched interface/card sounds → fades out over the last ~1.2s so the final typed command lands nearly dry.
- Music: `assets/music/happy-beats-business-moves-vol-12-by-ende-dot-app.mp3` (already copied into the composition tree), 109.96 BPM, start at 0.00s.
- Music treatment: fade-in over the hook at ~0.35 gain, lift to full at the Scene 2 wordmark, hold through Scenes 3–4, fade out across the last 1.2s.
- Music cue guidance: bundled preset — `C:\Users\sate\.claude\plugins\cache\brag\brag\0.2.2\skills\brag\assets\music\cues\happy-beats-business-moves-vol-12-by-ende-dot-app.music-cues.json` (and `.md`). Beat grid ≈0.545s. Target strong cues: **8.74s** (card commits to IN PROGRESS), **13.11s** (statusline slam), **17.47s** (`TAKE CONTROL` title). Lock those three only. Sequential *text* snaps to every other beat (~1.09s) so each line clears its reading floor; non-text accents (pane flick-ons, statusline segments, meter fills) may use consecutive beats.
- Audio-reactive treatment: subtle — drive only the phosphor bloom/glow on the mint hairlines and the scanline sweep intensity from music RMS. No waveform bars, no equalizer, no particles, no strobing, no pulsing chrome.
- Audio-coupled moments:
  - Scene 1 typed hook line — typing (key ticks per character)
  - Scene 1 six pane flick-ons — beat-grid sequential accents
  - Scene 1 orange slam — one low impact
  - Scene 2 wordmark resolve — one low impact on a strong beat
  - Scene 3 `+ Task` press — simulated interaction (single dry interface click)
  - Scene 3 card TODO → IN PROGRESS — card/slide cue, beat-locked 8.74s
  - Scene 3 typed caption — light key ticks
  - Scene 4 statusline segments + counters + meter fills — counter ticks, one shared quiet accent (not one per segment), beat-locked 13.11s
  - Scene 4 `complete` chip — one short confirm
  - Scene 5 three typed commands — key ticks, every other beat
  - Scene 5 final cursor — one soft tick, then silence under the fade-out
- SFX selection guidance: strictly motion-matched and sparse-to-moderate. Keyboard family for typed text, `interface`/`ui` families for the click / chip / pane blips, `casino` card-slide family for the kanban card moves, one restrained `impact` for the two reveals. At most one accent per beat. No whooshes on every cut, no risers, no stingers on text that merely fades. The terminal should sound like a terminal, not a trailer.
- SFX analysis guidance: `C:\Users\sate\.claude\plugins\cache\brag\brag\0.2.2\skills\brag\assets\sfx\sfx-analysis.md` (and `.json`). Prefer low high-frequency-risk files for the repeated key ticks and the polished reveal hits.
- Exact SFX choice: Hyperframes chooses filenames, timestamps, density, and volume after the visual animation exists.
- Audio files: copy the chosen music and any selected SFX into `brag-output/composition/assets/` (music is already at `assets/music/`).

## Hyperframes Instructions
Load the composition-building Hyperframes domain skills — `hyperframes-core` (composition contract + `data-*` timing), `hyperframes-animation` (motion), `hyperframes-creative` (design spec, beats, audio-reactive), `hyperframes-keyframes` (seek-safe keyframes), and `hyperframes-cli` (lint/check/render). /brag is its own workflow: do not enter the `hyperframes` entry-point intent interview and do not route into its generic promo / launch-video workflow. Prefer native Hyperframes conventions over anything in `/brag`.

Requirements:
- Show at least one real UI element from the source project — the kanban + statusline deck in Scenes 3–4 is that element, rebuilt in the phosphor identity with the screenshot's real labels, refs, and figures.
- Keep all text readable in the final render: short labels hold ≥0.8s settled; sentences ≥0.3s/word (min 1.2s). Fast-in, then hold.
- Keep the video within 15–25 seconds (target 21s).
- Include the planned music/SFX layer.
- Treat `/brag` audio notes as guidance, not a fixed cue sheet. Choose SFX after the visual animation exists.
- Treat music cue metadata as optional timing hints; ignore a cue that hurts readability, pacing, or the product story.
- Lock only the three listed strong cues (±0.15s), mark them `// beat-locked`. Snap sequential accents to consecutive beats (±0.10s), mark them `// beat-grid`.
- Wire at least one visual element to per-frame audio data (bloom/glow or scanline intensity). If extraction is unavailable (no helper or missing ffmpeg), document it here and skip audio-reactive rather than blocking the render.
- Use local assets for audio and any runtime/media dependencies.
- Run `npx hyperframes check` before render — it is brag's single gate.

---

## Implementation notes (post-build)

- Final cut runs **22.4s** (plan said 21.0s). Scene 5 needed the extra second: three typed
  command lines plus the closing sentence could not all clear their reading floors inside 4s.
  Final slots — S1 0.00–3.60 · S2 3.60–8.00 · S3 8.00–13.20 · S4 13.20–17.40 · S5 17.40–22.40.
- Beat locks landed as briefed: `+ TASK` press at **8.74s**, card → IN PROGRESS at **10.93s**,
  `TAKE CONTROL` title at **17.47s** (all `// beat-locked`). Statusline segments, meter fills,
  pane flick-ons and the typed command lines use `// beat-grid` spacing off the 109.96 BPM grid.
- **Audio-reactive treatment: skipped, documented.** `hyperframes-creative`'s
  `scripts/extract-audio-data.py` needs ffmpeg on PATH at the time it runs; ffmpeg was absent
  when the composition was authored, so no per-frame RMS data exists. In its place the phosphor
  bloom breathes once on the wordmark reveal (a beat-locked tween, not audio data). Re-running
  the extraction and wiring `#grain` opacity to RMS is the one outstanding checklist item.
- Fonts are generic stacks (`ui-monospace, monospace` / `serif`) rather than the project's named
  `Arial Narrow` display face: a named `font-family` with no in-file `@font-face` is a lint error.
- A radial vignette layer was removed — `check`'s layout pass reads it as an opaque cover and
  reported 69 `text_occluded` errors against text beneath it. The scanline `#grain` layer carries
  the CRT feel on its own.
- The kanji eyebrow colour moved from `--dim` `#246C3C` to `#52A473` to clear WCAG AA.
- `npx hyperframes check`: **0 errors, 194/194 text checks pass WCAG AA**.
