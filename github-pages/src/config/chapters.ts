// Transcribed from docs/one-shot/3d/sample-gitlab-3d-scan.html, source lines
// 750-785 (the CHAPTER_LEDGER). Two deliberate deviations from that shape:
//
//  - `el: '#hero'` (a selector string) becomes the typed `id` union — the
//    kebab-case chapter key doubles as the section's DOM id, its `.chapter`
//    modifier class and its stylesheet name, all named after the chapter's
//    title/component. One key, no second field to keep in sync.
//  - `weight` is new: it is the `data-weight` attribute on each chapter's
//    `.chapter-spacer` wrapper in the source markup (lines 499, 524, 551, 633, 650,
//    669, 694). It moves into the ledger because the scroll conductor pairs
//    spacers and chapters positionally — keeping the order in two places lets
//    them silently drift.

export type ChapterId =
  | 'orientation'
  | 'chaos'
  | 'agent-harness'
  | 'fleet-control'
  | 'tasks'
  | 'system-design'
  | 'skins'
  | 'pipeline'
  | 'themes'
  | 'openspec'
  | 'take-control'
  | 'developed-by'
  | 'advisors'
  | 'stats'
  | 'alternatives'
  | 'inspiration';

export interface ChapterWorld {
  fog: number; // FogExp2 density
  bloom: number; // UnrealBloomPass strength
  motes: number; // mote opacity multiplier
  exposure: number; // renderer.toneMappingExposure
}

// How much of a stepped chapter's own scroll goes to its steps. The camera
// parks for that stretch (see createWorld's dwellProgress) and the bands are
// cut from it (see deck/useScrollStep.ts) — one constant, or the panel would
// start sailing away mid-step.
export const STEP_BAND_SPAN = 0.55;

export interface Chapter {
  id: ChapterId;
  weight: number; // spacer height in viewport heights
  /** Sub-views the chapter's own scroll steps through — the fleet-control
   *  tabs, the tasks flow. Omitted for the chapters that have none. Budget
   *  ~0.7 of `weight` per step, or the bands fly past. */
  steps?: number;
  num: string;
  jp: string;
  code: string;
  title: string;
  sub: string;
  u: readonly [number, number, number]; // anchor as fractions of the fitted scan bbox
  yaw: number; // degrees
  pitch: number; // degrees
  w: number; // world width
  px: number; // CSS px width, desktop
  pxm: number; // CSS px width, <=900px
  fill: number;
  lift: number;
  tone: number;
  world: ChapterWorld;
}

// Anchors are fractions of the scan's bounding box, resolved to world space
// after the model is fitted, so retuning MODEL_SIZE never invalidates them.
// u: [x as fraction of half-width, y as fraction of height, z as fraction of
// half-depth]. yaw: degrees; the screen's normal is (sin yaw, 0, cos yaw) and
// the camera always parks on that side.
//
// ─── HOW THESE ANCHORS WERE CHOSEN, AND TWO WAYS TO GET IT WRONG ────────────
// The tour is a WALK, not an orbit: exterior approach, two interior shots down
// the -X wall, a long interior shot, then across the +X wall, up to +Z, over to
// -X, and back outside for the CTA and the closing pair. Every screen faces a
// different way, at a different height. Both failure modes below were actually
// built and thrown away, so they are worth stating:
//
//  1. DON'T PUSH ANCHORS OUT INTO SPACE "to give them room". The camera is
//     DERIVED, never authored: `cam = anchor + normal * framingDistance`, and
//     that distance is already 6-8 units. Anchors belong on or near the
//     building's surface — the fitted bbox is halfX 5.615, height 9.043,
//     halfZ 6.000. An anchor at radius 14 puts the camera at 22, where the scan
//     is a speck and the screen floats in a black void.
//  2. DON'T EVEN OUT THE CAMERA STEPS BY SWEEPING A CONSTANT BEARING with every
//     screen facing radially outward. It does produce beautifully uniform steps
//     — and it reads as a carousel, the panels visibly revolving around the
//     building instead of being placed in it. Even spacing and varied placement
//     are independent goals; do not buy one with the other.
//
// So the steps here are deliberately uneven (1.3 to 12.3 world units) because
// the placement is what matters. SMOOTHNESS OF THE MOTION IS SOLVED ELSEWHERE:
// `easeSettle` in createWorld.ts eases the camera into and out of every
// waypoint, and the conductor's damping is 3.8. That is the right place for it
// — those two change how the camera moves, not where the screens are.
//
// The numbers to check an edit against. The fitted bbox is halfX 5.615,
// height 9.043, halfZ 6.000, so an anchor's world position is
// (u.x * 5.615, u.y * 9.043, u.z * 6.000), and `framingDistance` puts the
// camera 6-8 units out along the screen's normal:
//
//   fill        <= 0.82. Above ~0.84 of the frame a panel slides under the fixed
//               chapter rail on the right. Tall panels are governed by the
//               vertical term instead and land well under this anyway.
//   view angle  keep a chapter's view direction >= ~30° away from antiparallel
//               to EITHER neighbour's. See the note on `tasks` for what
//               happens otherwise, and remember it is a chain: rotating a
//               chapter to fix one seam can hand the same problem to the other.
//   separation  only ADJACENT chapters are ever mounted together (updateWorld
//               culls on `1 - |i - smooth| > 0.001`), so only neighbours can
//               collide. Two near-coplanar neighbours facing the same way need
//               either half their combined width apart across the wall, or half
//               their combined height apart vertically — see `fleet-control`.
//
// `pnpm dev` then http://localhost:5173/?debug draws both spline curves, boxes
// every anchor, and prints live camera/target/bbox values. That overlay is the
// supported way to eyeball an edit; the rules above are what to eyeball it for.
export const CHAPTERS = [
  {
    id: 'orientation', weight: 1.30, num: '01', jp: '到着', code: 'SCR·01', title: 'ORIENTATION',
    sub: 'WHERE IT ALL BEGINS',
    u: [1.52, 0.53, 0.36], yaw: 78, pitch: 0, w: 5.8, px: 1240, pxm: 760,
    fill: 0.64, lift: 0.35, tone: 0x52F29A, world: { fog: 0.052, bloom: 0.62, motes: 0.85, exposure: 1.06 },
  },

  {
    id: 'chaos', weight: 1.10, num: '02', jp: '混沌', code: 'SCR·02', title: 'CHAOS',
    sub: 'A JUGGLING ACT',
    u: [0.620, 0.760, 0.880], yaw: 32, pitch: -4, w: 5.6, px: 1240, pxm: 760,
    fill: 0.84, lift: 0.15, tone: 0xE2280F, world: { fog: 0.040, bloom: 0.58, motes: 0.7, exposure: 1.02 },
  },

  {
    id: 'agent-harness', weight: 1.75, num: '03', jp: '系統', code: 'SCR·03', title: 'AGENT HARNESS',
    sub: 'MANAGE OPERATIONAL SURFACES',
    u: [-0.840, 0.755, 0.440], yaw: 96, pitch: 6, w: 6.2, px: 1420, pxm: 770,
    fill: 0.92, lift: 0.10, tone: 0x5090D0, world: { fog: 0.024, bloom: 0.70, motes: 0.5, exposure: 1.0 },
  },

  {
    id: 'fleet-control', weight: 3.40, steps: 4, num: '04', jp: '制御', code: 'SCR·04', title: 'FLEET CONTROL',
    sub: 'ONE LIVE DECK · SESSIONS · TASKS · AUTOMATION · USAGE',
    // Sits LOW on the -X wall on purpose. `agent-harness` is on the same wall
    // facing the same way (near-coplanar, 0.4 units apart in depth), and the two
    // panels are ~4.3 and ~4.6 world units tall — so anything less than ~4.5
    // units of vertical separation has them overlapping in frame during the
    // seam. At y-fraction 0.255 the gap is 4.52. Do not raise this without
    // lowering `agent-harness` or pushing one of them along the wall in Z.
    u: [-0.870, 0.255, -0.180], yaw: 90, pitch: 0, w: 6.4, px: 1460, pxm: 780,
    fill: 0.92, lift: 0.05, tone: 0xF26400, world: { fog: 0.026, bloom: 0.74, motes: 0.5, exposure: 1.0 },
  },

  // THE tasks -> system-design SEAM — the worst transition in the deck, fixed
  // in three parts. `tasks` faces +Z from the far wall and `system-design`
  // faces +Z from the near one, so the camera has to end up pointing the
  // opposite way. Left alone that is a 180° pivot almost on the spot: the two
  // waypoints are only 4.8 units apart, the look-at target curve passed within
  // 0.69 units of the camera (a singularity — rotation peaked at 2125 deg per
  // chapter of scroll, against ~120 for a normal seam), and at the midpoint
  // the camera stared at bare wall with BOTH panels culled by the relevance
  // window's `dot(forward) > 0` test. An empty room for 1.5 viewport-heights.
  //
  //  - `system-design.via` gives the segment a THREE-POINT TURN: reverse out
  //    past the +X side, swing across, then come in facing the other way. The
  //    camera now travels while it rotates, which is what makes the
  //    reorientation read as a manoeuvre rather than a spin, and it keeps
  //    geometry in frame throughout instead of sweeping past nothing.
  //  - Both weights are padded past what their content needs (1.20 / 1.30
  //    originally) so the move has room: the conductor spaces anchors by half of
  //    each spacer's height, so this widens the segment ~26%.
  //  - createWorld's updateWorld slerps orientation between composed framings
  //    rather than re-deriving a look-at every frame, which is what removes the
  //    singularity itself — here and at every other seam.
  {
    id: 'tasks', weight: 4.20, steps: 5, num: '05', jp: '流程', code: 'SCR·05', title: 'GET TASKS DONE',
    sub: 'SPEC → TASK → WORKTREE → AGENT → REVIEW',
    u: [0.640, 0.300, 0.850], yaw: 47, pitch: 0, w: 5.9, px: 1340, pxm: 760,
    fill: 0.90, lift: 0.10, tone: 0x0C6C80, world: { fog: 0.028, bloom: 0.66, motes: 0.55, exposure: 1.0 },
  },

  {
    id: 'system-design', weight: 1.30, num: '06', jp: '局所', code: 'SCR·06', title: 'SYSTEM DESIGN',
    sub: 'YOUR MACHINE · YOUR STATE · YOUR AGENTS',
    u: [0.040, 0.400, -0.800], yaw: 4, pitch: 0, w: 5.8, px: 1320, pxm: 760,
    fill: 0.78, lift: 0.30, tone: 0x52F29A, world: { fog: 0.032, bloom: 0.68, motes: 0.7, exposure: 1.02 },
  },

  // ─── the frontend debrief, sections 01-04 ────────────────────────────────
  // Transcribed from docs/one-shot/slides/index.html (sections #system,
  // #pipeline, #skill, #spec). Placed to continue the walk from `local` rather
  // than to sit a fixed sweep away from it: across the +X wall low (skins), up
  // to the +Z wall (pipeline), over to -X (themes), then back outside to +X for
  // the spec ledger. `pipeline` and `themes` carry the most content, so they
  // take the widest `fill` — both are tall enough that the vertical framing
  // term wins and they still land at ~0.66 of the frame, well clear of the rail.

  {
    id: 'skins', weight: 1.25, num: '07', jp: '体系', code: 'SCR·07', title: 'ONE SYSTEM, TWO THEMES',
    sub: 'SWAP THE TOKENS. KEEP THE SYSTEM.',
    u: [0.801, 0.332, 0.250], yaw: 270, pitch: 0, w: 5.9, px: 1340, pxm: 760,
    fill: 0.80, lift: 0.16, tone: 0xF26400, world: { fog: 0.030, bloom: 0.66, motes: 0.62, exposure: 1.02 },
  },

  // Stepped like `fleet-control` and `tasks`: the camera parks on this panel
  // for the first STEP_BAND_SPAN of its segment while the reader scrolls the
  // five stages as bands (see deck/useScrollStep.ts), and the autoplay tour
  // stops on each stage. Weight 3.50 gives the five bands ~0.7 vh each — the
  // budget below which bands fly past. Stage selection moved off the old
  // continuous ±0.45 sweep (driveFromScroll) onto the band system to match.
  {
    id: 'pipeline', weight: 3.50, steps: 5, num: '08', jp: '経路', code: 'SCR·08', title: 'THE PHOSPHOR PIPELINE',
    sub: '08 PAGES · 34 EXPERIMENTS · 23 REFERENCES',
    u: [-0.178, 0.796, 0.833], yaw: 182, pitch: 4, w: 6.5, px: 1500, pxm: 780,
    fill: 0.94, lift: 0.10, tone: 0x0C6C80, world: { fog: 0.022, bloom: 0.72, motes: 0.48, exposure: 1.0 },
  },

  {
    id: 'themes', weight: 1.95, num: '09', jp: '技能', code: 'SCR·09', title: 'TWO THEMES, TWO SKILLS',
    sub: 'TEACH IT ONCE, NOT EVERY PROMPT',
    u: [-0.819, 0.730, -0.200], yaw: 88, pitch: 0, w: 6.5, px: 1500, pxm: 780,
    fill: 0.94, lift: 0.12, tone: 0x52F29A, world: { fog: 0.026, bloom: 0.78, motes: 0.55, exposure: 1.04 },
  },

  {
    id: 'openspec', weight: 1.70, num: '10', jp: '仕様', code: 'SCR·10', title: 'OPENSPEC',
    sub: 'PROPOSAL → DESIGN → SPEC → TASKS',
    u: [0.890, 0.575, -0.933], yaw: 120, pitch: 0, w: 6.2, px: 1440, pxm: 770,
    fill: 0.80, lift: 0.08, tone: 0x0C6C80, world: { fog: 0.028, bloom: 0.70, motes: 0.58, exposure: 1.02 },
  },

  {
    id: 'take-control', weight: 1.30, num: '11', jp: '開始', code: 'SCR·11', title: 'TAKE CONTROL',
    sub: 'CLONE · BOOTSTRAP · START',
    u: [1.160, 1.080, -0.420], yaw: 116, pitch: -6, w: 5.2, px: 1140, pxm: 750,
    fill: 0.72, lift: 0.55, tone: 0x7CF4AB, world: { fog: 0.044, bloom: 0.86, motes: 0.9, exposure: 1.08 },
  },

  // ─── the closing sequence ────────────────────────────────────────────────
  // Who built it, who it owes, what it cost, the alternatives around it, then
  // what it was built from. These sit behind the CTA, carrying the camera from
  // -Z to -X.
  //
  // The five anchors below belong to the SLOTS, not to the slides sitting in
  // them: they are one continuous sweep (yaw 182 → 272, x +0.10 → -1.34) with
  // its clearances tuned as a chain. Reordering the closing slides means moving
  // the content fields — id/jp/title/sub/weight and the panel's w/px/pxm/
  // fill/lift/tone — between these entries, and leaving u/yaw/pitch/world/num/
  // code where they are. Carrying an anchor along with its slide instead makes
  // the camera double back mid-sequence.

  {
    id: 'developed-by', weight: 1.60, num: '12', jp: '開発', code: 'SCR·12', title: 'DEVELOPED BY',
    sub: 'SAM TEONG · JAIRUS ARAGON',
    u: [0.10, 1.16, -1.12], yaw: 182, pitch: -4, w: 6.0, px: 1360, pxm: 760,
    fill: 0.86, lift: 0.34, tone: 0xF49F09, world: { fog: 0.030, bloom: 0.70, motes: 0.6, exposure: 1.02 },
  },

  {
    id: 'advisors', weight: 1.55, num: '13', jp: '謝辞', code: 'SCR·13', title: 'SPECIAL THANKS',
    sub: 'KEVIN LIN · MIN SOE ZAN',
    u: [-0.72, 1.05, -0.92], yaw: 212, pitch: -2, w: 5.8, px: 1300, pxm: 760,
    fill: 0.82, lift: 0.40, tone: 0x7CF4AB, world: { fog: 0.034, bloom: 0.74, motes: 0.72, exposure: 1.03 },
  },

  {
    id: 'stats', weight: 1.30, num: '14', jp: '統計', code: 'SCR·14', title: 'STATS',
    sub: 'WHAT IT TOOK TO GET HERE',
    u: [-1.04, 0.54, -0.74], yaw: 242, pitch: 0, w: 6.0, px: 1360, pxm: 770,
    fill: 0.80, lift: 0.20, tone: 0x5090D0, world: { fog: 0.038, bloom: 0.78, motes: 0.82, exposure: 1.04 },
  },

  // `x`/`z` interpolated between the slot above and the slot below; yaw 257 is
  // 15° off each neighbour, nowhere near the antiparallel danger zone. `y` is
  // NOT the midpoint, though — see below.
  //
  // These last three slots are near-coplanar, all stacked in roughly the same
  // corner, same as agent-harness/fleet-control — so per that seam's rule they
  // need HEIGHT-based separation, not just a different yaw. The original
  // two-slot ledger had u.y=0.54 and u.y=0.92, a proven-safe 0.38 gap (~3.44
  // world units, since height=9.043). Inserting a third slot at the linear y
  // midpoint (0.73) would have HALVED that clearance on both sides to ~1.72
  // units each — which is exactly what overlapped in practice. Fix: stack the
  // same proven 0.38 gap upward twice instead of splitting it once.
  {
    id: 'alternatives', weight: 1.70, num: '15', jp: '比較', code: 'SCR·15', title: 'ALTERNATIVES',
    sub: 'CONDUCTOR · BUZZ · GROKBOT',
    u: [-1.19, 0.92, -0.65], yaw: 257, pitch: 0, w: 6.5, px: 1500, pxm: 780,
    fill: 0.90, lift: 0.24, tone: 0xF26400, world: { fog: 0.040, bloom: 0.79, motes: 0.86, exposure: 1.05 },
  },

  {
    id: 'inspiration', weight: 1.45, num: '16', jp: '源泉', code: 'SCR·16', title: 'INSPIRATION',
    sub: 'KARPATHY · POCOCK · HERK · HANNEGAN',
    u: [-1.34, 1.30, -0.56], yaw: 272, pitch: 0, w: 6.5, px: 1500, pxm: 780,
    fill: 0.90, lift: 0.18, tone: 0x52F29A, world: { fog: 0.042, bloom: 0.80, motes: 0.9, exposure: 1.06 },
  },
] as const satisfies readonly Chapter[];

export type ChapterEntry = (typeof CHAPTERS)[number];

// `as const` keeps the entries at their literal types, which have no `steps`
// property at all on the chapters that omit it — so the lookup is derived once
// here, through the wider interface, rather than cast at each call site.
export const STEPS_BY_INDEX: readonly number[] = CHAPTERS.map((c: Chapter) => c.steps ?? 0);
