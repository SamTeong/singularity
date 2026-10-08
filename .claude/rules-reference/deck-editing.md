# Deck editing runbook

Paths (`src/...`, `scripts/...`) are relative to `github-pages/`; run `pnpm ...` commands from there.

Read when adding, removing, or reordering slides in `github-pages/`. Core model and invariants: `github-pages/CLAUDE.md`, `.claude/rules/deck-invariants.md`.

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
