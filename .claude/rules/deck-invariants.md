---
paths:
  - "github-pages/**"
---

# Deck invariants

## The two invariants that will bite you

Both are consequences of the same thing: `CSS3DObject` **reparents** the real
`<section>` nodes out of `<main id="scroll">` into a Three.js-owned container.
React keeps a pointer to each node but no longer knows its parent.

**1. Slides render unconditionally, in fixed order.** No `{cond && <Slide/>}`,
no `.filter()`, no `React.lazy` / `<Suspense>` above them, no conditionally
swapped element type. React would call `removeChild`/`insertBefore` on the *old*
parent and either throw `NotFoundError` or silently yank the node back out of the
3D world. To hide a slide, remove it from the ledger — don't conditionally render it.

**2. `className`, `id` and `style` on the `<section>` are constant literals.**
The world adds `.as-panel` to that element's `classList` and writes
`width`/`height`/`display`/`opacity` on it every frame. React rewrites the whole
className string whenever the prop value changes, which would silently delete
`.as-panel` and collapse the slide's layout mid-scroll — with no error. Put any
dynamic state on a descendant or a `data-*` attribute.

The full contract is at the top of `src/components/chapters/Spacer.tsx`. A dev-only
`MutationObserver` shouts in the console if either is violated.

Everything *inside* a slide is normal React. Update it freely.

---

## Also worth knowing

- **60 fps values never go into React state.** Camera, fog, bloom, panel opacity
  and the per-frame HUD writes stay in `src/world/` and apply through refs.
  React state is for slide changes and UI state.
- **Only `src/world/` may import `three`.** ESLint enforces it, including
  `three/addons/*`. It is what keeps the ~590 kB chunk off the wire in flat mode.
- **Reference public assets via `import.meta.env.BASE_URL`**, never a leading `/`.
  The site deploys to a Pages project subpath and an absolute path 404s there.
- **The deck must survive without WebGL.** If the model fails, the viewport is
  ≤900 px, or the GPU context is lost, every slide is served as an ordinary
  scrollable page. Don't make slide content depend on the 3D layer.
- Per-slide simulated content (terminals, telemetry, charts) lives in
  `src/deck/`. Reuse `Segments`, `Metric`, `TerminalPane`, `UsageChart` rather
  than writing new imperative DOM.
- **A slide with sub-views is driven by its own scroll**, not by a second
  interaction: `src/deck/useScrollStep.ts` splits the first 55% of the slide's
  scroll into one band per sub-view (fleet control's 4 tabs, the tasks flow's 5
  stages), and its buttons scroll to a band rather than setting state. That is
  why those two entries carry a much larger `weight` — give a stepped slide
  roughly 0.7vh of `weight` per step, or the bands fly past.
- The top bar's two toggles (`MODE 2D/3D`, `AUTO`) are plain App state:
  `MODE` flips the mode machine, which unmounts `<ThreeWorld/>` and lets the
  flat fallback stand; `AUTO` (`src/app/useAutoplay.ts`) tours the stops —
  slides, plus each stepped slide's bands — looping after the last one. Its two
  durations are independent: a fixed dwell at each stop, and a glide between
  them whose length is only distance ÷ speed. Never cap the glide; the cap
  becomes the speed and a rushed glide is what reads as a jump.
- Reduced motion is sampled once at load and gates typing delays, autoplay, the
  telemetry tick and camera smoothing. Honour `REDUCED_MOTION` from
  `src/lib/env.ts` in anything you animate.
