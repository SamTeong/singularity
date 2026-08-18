# Scanned Deck — 3D walkthrough

React + Vite + TypeScript port of `docs/one-shot/3d/sample-gitlab-3d-scan.html`.

One persistent Three.js world built around a photogrammetry scan
(`scan-atrium.glb`), with the seven product-deck chapters mounted inside it as
`CSS3DObject` screens and a scroll conductor driving the camera on rails.

## Run

```bash
pnpm install     # standalone — NOT part of the root pnpm workspace
pnpm dev         # http://localhost:5173
pnpm build       # -> dist/ (fully static)
pnpm preview
pnpm lint
```

`predev`/`prebuild` run `scripts/copy-model.mjs`, which copies the 11.5 MB
`scan-atrium.glb` from `../docs/one-shot/3d/`. The model is **gitignored here**
so the repo stores exactly one copy of it.

Must be served over http(s) — `file://` blocks the model fetch.

## Architecture

```
React UI / deck  ──►  ScrollConductor  ──►  Three.js world
   (src/deck,            (src/world/           (src/world/)
    components/)          conductor.ts)
```

React owns the application and UI. Three.js stays raw and imperative — no React
Three Fiber. The conductor connects them.

| Directory | Holds |
|---|---|
| `src/config/chapters.ts` | the chapter ledger — the single source of truth for order, ids (one kebab-case key per chapter, reused as the DOM id, the `.chapter` modifier class and the stylesheet name), camera anchors, screen geometry, HUD copy and per-chapter atmosphere |
| `src/components/` | the deck markup, converted near-mechanically from the one-shot |
| `src/deck/` | the deck's *simulation* (terminal typewriter, 4 Hz telemetry, usage canvas, tabs, flow stepper, copy button) |
| `src/world/` | the imperative Three.js world + scroll conductor. The **only** place allowed to import `three` (enforced by ESLint) |
| `src/app/` | capability probe, body-mode classes, element registries, scroll restoration |
| `src/styles/` | the original stylesheet, split into files that are byte-identical to their source line ranges and imported once, in source order |

### Two rules worth knowing before editing

**The panel DOM contract** (`src/components/chapters/Spacer.tsx`). `CSS3DObject`
reparents the seven `<section class="chapter">` nodes out of `<main id="scroll">`.
React keeps a pointer to each but no longer knows its parent, so subtree updates
are fine and *structural* changes are not. The chapters must stay rendered
unconditionally, in fixed order, with constant-literal `className`/`id` and no
`style` prop. A dev-only `MutationObserver` shouts if that is violated.

**60 fps values never go into React state.** Camera, fog, bloom, panel opacity
and the per-frame HUD writes stay in the world and are applied through refs.
React state is for chapter changes and UI state.

## Fallback

If WebGL2 is unavailable, the viewport is ≤900 px, the model fails to load, or
the GPU context is lost mid-session, the app serves the full product deck as an
ordinary scrollable page. Flat mode never downloads the ~590 kB Three.js chunk.

## Verification

```bash
node scripts/verify-world.mjs   # drives the real 3D experience headlessly (32 checks)
node scripts/parity.mjs         # diffs the flat deck against the original one-shot
```

Both use the root repo's `playwright-core` with SwiftShader. Serve the original
alongside for parity runs:

```bash
python3 -m http.server 8080 --bind 127.0.0.1 --directory ../docs
```

## Deployment

`base: './'` — every asset reference is relative, so the build works at a
GitHub Pages project subpath (and would work on GitLab Pages unchanged).
`.github/workflows/pages.yml` builds and deploys on pushes to `main` that touch
this directory.
