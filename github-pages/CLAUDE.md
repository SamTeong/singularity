# CLAUDE.md — editing the deck

This app is a **slide deck**: thirteen chapters ("slides") mounted as real DOM
inside one persistent Three.js world, toured by a scroll-driven camera on rails.
Adding, removing, and reordering slides is the routine edit, and this file is the
runbook for it.

Read `README.md` first for the architecture. This file is only about editing slides.

## The mental model

A slide is **one row in a ledger plus one React component**. Everything else is
derived:

```
src/config/chapters.ts   ← the ledger. Order, ids, camera placement, HUD copy,
                            per-slide atmosphere. THE source of truth.
        │
        ├──► Chapters.tsx renders one <Spacer> + <Section> per entry, in ledger
        ├──► the scroll conductor derives anchors from each entry's `weight`
        ├──► the world derives camera waypoints from `u` / `yaw` / `pitch` /
        │      `fill` / `lift` — you never author a camera position
        └──► the HUD, chapter rail and top bar read `num` / `jp` / `code` /
               `title` / `sub`
```

**Never hand-author a camera position.** Waypoints are computed: each is the
slide's anchor pushed out along its own face normal by exactly the distance that
frames it at the current aspect ratio (`framingDistance` in `cameraPath.ts`).
That is why the composition survives any window size. Tune `u`/`yaw`/`fill`, not
the camera.

---

## Add a slide

Four files, in this order. TypeScript will fail the build if you miss one — the
unions and the `Record<ChapterId, …>` map are exhaustive on purpose.

**1. `src/config/chapters.ts`** — add the id to the union, then add the entry
at the position in the array where you want it to appear.

```ts
// One kebab-case key per slide. It is the ledger key, the spacer's
// data-chapter, the <section> id / in-page anchor, the `.chapter` modifier
// class and the stylesheet name — keep all five spellings identical.
export type ChapterId = … | 'pricing';
```

```ts
{
  id: 'pricing',
  weight: 1.30,            // slide length in viewport heights — dwell time
  num: '08', jp: '価格', code: 'SCR·08',
  title: 'PRICING',        // HUD caption
  sub: 'WHAT IT COSTS',    // HUD sub-caption
  u: [0.9, 0.55, -0.3],    // anchor, as fractions of the scan bbox — see below
  yaw: 45, pitch: 0,       // which way the screen faces, in degrees
  w: 5.8,                  // screen width in world units
  px: 1240, pxm: 760,      // CSS pixel width: desktop / ≤900px
  fill: 0.8,               // how much of the frame it should occupy (0-1)
  lift: 0.2,               // camera rise above the anchor
  tone: 0x52F29A,          // the WebGL frame colour around the screen
  world: { fog: 0.04, bloom: 0.66, motes: 0.7, exposure: 1.02 },
}
```

Name the id after the slide's title, in kebab-case, and give the component and
the stylesheet the same name (`take-control` → `TakeControl.tsx` →
`chapters/take-control.css`). There is no second id field to keep in sync.

**2. `src/components/chapters/Pricing.tsx`** — copy the shape of
`SystemDesign.tsx` (a simple one; `FleetControl/FleetControl.tsx` is the
complex one).

```tsx
import type { ChapterProps } from './types';

export function Pricing({ sectionRef }: ChapterProps) {
  // className and id MUST be constant literals, and this element must never
  // receive a `style` prop — see the PANEL DOM CONTRACT in Spacer.tsx.
  return (
    <section className="chapter pricing" id="pricing" aria-labelledby="pricing-title" ref={sectionRef}>
      <div className="chapter-inner">
        <div className="section-head">
          <span className="idx">08</span><span className="jp">価格</span>
          <h2 id="pricing-title">PRICING</h2>
        </div>
        …
      </div>
    </section>
  );
}
```

Reuse the existing primitives rather than inventing classes: `.chapter-inner`,
`.section-head`, `.eyebrow`, `.display`, `.lead`, `.stamp`, `.btn`, and the
colour helpers `.c-mint` / `.c-blue` / `.c-amber` / `.c-red` / `.c-orange` are
all defined in `src/styles/deck.css`.

**3. `src/components/chapters/index.ts`** — add it to the map.

**4. Slide-specific CSS**, only if the primitives aren't enough: create
`src/styles/chapters/pricing.css` and add one `@import` to
`src/styles/index.css`, **before** `panel.css`. Order in that file is
load-bearing — several overrides win on source order, not specificity, and
`responsive.css` must stay last.

### Choosing `u`, `yaw` and `pitch`

`u` is a fraction of the scan's fitted bounding box, not metres:
`[x / half-width, y / height, z / half-depth]`. So `[0, 0.5, 0]` is dead centre,
half-height; `[1, …]` is the +X wall; `[-1, …]` the −X wall.

Use the debug overlay rather than guessing:

```
pnpm dev   →  http://localhost:5173/?debug
```

It prints live `camera`, `target` and `bbox` values, draws both spline curves,
and boxes every anchor. Scroll to where you want the slide, read the `camera`
line, divide by the `bbox` extents, and use that as a starting `u`. Then adjust
`yaw` until the screen faces the camera (it's the compass bearing of the screen's
normal, in degrees) and `fill` until it sits comfortably in frame.

`pitch` is optional and usually `0` — use it only for screens above or below eye
level. The Euler order is `'YXZ'` for a reason: under the default order a pitch
on a yawed screen becomes a roll.

**Two rules the ledger's header comment spells out, worth knowing before you
start.** Both were learned by shipping the wrong thing:

- **Keep anchors on the building.** The camera is derived, `anchor + normal *
  framingDistance`, and that distance is already 6-8 units. An anchor pushed out
  to radius 14 "for room" puts the camera at 22, where the scan is a speck.
- **Never let a slide's view direction end up antiparallel to a neighbour's.**
  A 180° seam has no graceful execution: the camera pivots on the spot, the
  look-at target passes through the camera (a singularity), the relevance window
  culls *both* panels at the midpoint so you get an empty room, and even slerped
  orientations are undefined halfway. Stay ≥30° off antiparallel, and check both
  neighbours — it's a chain.

---

## Remove a slide

1. Delete its entry from `CHAPTERS` and its id from the `ChapterId` union.
2. Delete the component and its entry in `index.ts`.
3. Delete its CSS file and the `@import`.
4. **Check for in-page anchors pointing at it.** These exist today:
   - `Orientation.tsx` → `href="#chaos"` and `href="#take-control"`
   - `TakeControl.tsx` → `href="#orientation"`

   A dangling `href="#removed"` fails silently — the click just does nothing.
   `grep -rn 'href="#' src` after any removal.

Nothing else needs touching: the screen count in the readout and the boot status
line are both derived from the ledger.

**Minimum two slides.** The camera path is a Catmull-Rom curve through the
waypoints; a single point has no curve to travel along.

## Reorder slides

Move the entry within the `CHAPTERS` array. That's the whole edit — spacers,
panels, camera path and rail all read the array in order, and `Chapters.tsx`
renders from it.

Renumber `num` / `code` to match, or the HUD will read `05` on the third slide.

---

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
- Reduced motion is sampled once at load and gates typing delays, autoplay, the
  telemetry tick and camera smoothing. Honour `REDUCED_MOTION` from
  `src/lib/env.ts` in anything you animate.

## After editing — always

```bash
pnpm build && pnpm lint          # the unions and the component map are exhaustive
node scripts/verify-world.mjs    # 32 checks: boots, panels mount, scroll drives
                                 # the camera, fallback + teardown are clean
```

`verify-world.mjs` needs the app served — `pnpm build && npx vite preview --port 4319`,
or point it elsewhere with `APP_URL=…`. It uses the root repo's `playwright-core`
under SwiftShader, so its FPS numbers are meaningless; ignore them.

Then **look at it**: `pnpm dev` and scroll the whole deck. This project's history
is explicit that every real bug in the original build was found by looking at
rendered output and none by DOM assertions. A slide can be structurally perfect
and still be facing the wrong way, clipped by its bezel, or parked inside a wall.
