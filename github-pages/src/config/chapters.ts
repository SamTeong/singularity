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
  | 'appendix-a'
  | 'appendix-b';

export interface ChapterWorld {
  fog: number; // FogExp2 density
  bloom: number; // UnrealBloomPass strength
  motes: number; // mote opacity multiplier
  exposure: number; // renderer.toneMappingExposure
}

export interface Chapter {
  id: ChapterId;
  weight: number; // spacer height in viewport heights
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
export const CHAPTERS = [
  {
    id: 'orientation', weight: 1.30, num: '01', jp: '到着', code: 'SCR·01', title: 'ORIENTATION',
    sub: 'WHERE IT ALL BEGINS',
    u: [1.52, 0.53, 0.36], yaw: 78, pitch: 0, w: 5.8, px: 1240, pxm: 760,
    fill: 0.64, lift: 0.35, tone: 0x52F29A, world: { fog: 0.052, bloom: 0.62, motes: 0.85, exposure: 1.06 },
  },

  {
    id: 'chaos', weight: 1.10, num: '02', jp: '混沌', code: 'SCR·02', title: 'CHAOS',
    sub: 'SEVEN TERMINALS, NO SHARED PICTURE',
    u: [0.62, 0.76, 0.88], yaw: 32, pitch: -4, w: 5.6, px: 1240, pxm: 760,
    fill: 0.84, lift: 0.15, tone: 0xE2280F, world: { fog: 0.040, bloom: 0.58, motes: 0.7, exposure: 1.02 },
  },

  {
    id: 'agent-harness', weight: 1.75, num: '03', jp: '系統', code: 'SCR·03', title: 'AGENT HARNESS',
    sub: 'EIGHT OPERATIONAL SURFACES AROUND THE WORK',
    u: [-0.84, 0.755, 0.44], yaw: 96, pitch: 6, w: 6.2, px: 1420, pxm: 770,
    fill: 0.92, lift: 0.10, tone: 0x5090D0, world: { fog: 0.024, bloom: 0.70, motes: 0.5, exposure: 1.0 },
  },

  {
    id: 'fleet-control', weight: 1.85, num: '04', jp: '制御', code: 'SCR·04', title: 'FLEET CONTROL',
    sub: 'ONE LIVE DECK · SESSIONS · TASKS · AUTOMATION · USAGE',
    u: [-0.87, 0.475, -0.10], yaw: 90, pitch: 0, w: 6.4, px: 1460, pxm: 780,
    fill: 0.92, lift: 0.05, tone: 0xF26400, world: { fog: 0.026, bloom: 0.74, motes: 0.5, exposure: 1.0 },
  },

  {
    id: 'tasks', weight: 1.20, num: '05', jp: '流程', code: 'SCR·05', title: 'GET TASKS DONE',
    sub: 'SPEC → TASK → WORKTREE → AGENT → REVIEW',
    u: [0.64, 0.42, 0.85], yaw: 176, pitch: 0, w: 5.9, px: 1340, pxm: 760,
    fill: 0.90, lift: 0.10, tone: 0x0C6C80, world: { fog: 0.028, bloom: 0.66, motes: 0.55, exposure: 1.0 },
  },

  {
    id: 'system-design', weight: 1.30, num: '06', jp: '局所', code: 'SCR·06', title: 'SYSTEM DESIGN',
    sub: 'YOUR MACHINE · YOUR STATE · YOUR AGENTS',
    u: [0.04, 0.40, -0.80], yaw: 4, pitch: 0, w: 5.8, px: 1320, pxm: 760,
    fill: 0.78, lift: 0.30, tone: 0x52F29A, world: { fog: 0.032, bloom: 0.68, motes: 0.7, exposure: 1.02 },
  },

  // ─── the frontend debrief, sections 01-04 ────────────────────────────────
  // Transcribed from docs/one-shot/slides/index.html (sections #system,
  // #pipeline, #skill, #spec). Anchors authored against the real fitted bbox
  // of scan-atrium.glb — halfX 5.615, height 9.043, halfZ 6.000 — so the four
  // continue the tour as three interior shots (the argument, the pipeline, the
  // two themes) before the camera steps back outside for the spec ledger and
  // the CTA. Every camera step here is ≤ 11.8 world units, the same range the
  // original seven already used.

  {
    id: 'skins', weight: 1.25, num: '07', jp: '体系', code: 'SCR·07', title: 'ONE SYSTEM, TWO SKINS',
    sub: 'ZAPAC BY DEFAULT · PHOSPHOR FOR NOSTALGIA',
    u: [0.801, 0.332, 0.250], yaw: 270, pitch: 0, w: 5.9, px: 1340, pxm: 760,
    fill: 0.88, lift: 0.16, tone: 0xF26400, world: { fog: 0.030, bloom: 0.66, motes: 0.62, exposure: 1.02 },
  },

  {
    id: 'pipeline', weight: 2.10, num: '08', jp: '経路', code: 'SCR·08', title: 'THE PHOSPHOR PIPELINE',
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
    id: 'openspec', weight: 1.70, num: '10', jp: '仕様', code: 'SCR·10', title: 'OPENSPEC SHIPS THE ONE-SHOT',
    sub: 'PROPOSAL → DESIGN → SPEC → TASKS',
    u: [0.890, 0.575, -0.567], yaw: 120, pitch: 0, w: 6.2, px: 1440, pxm: 770,
    fill: 0.92, lift: 0.08, tone: 0x0C6C80, world: { fog: 0.028, bloom: 0.70, motes: 0.58, exposure: 1.02 },
  },

  {
    id: 'take-control', weight: 1.30, num: '11', jp: '開始', code: 'SCR·11', title: 'TAKE CONTROL',
    sub: 'CLONE · BOOTSTRAP · START',
    u: [1.16, 1.08, -0.42], yaw: 116, pitch: -6, w: 5.2, px: 1140, pxm: 750,
    fill: 0.72, lift: 0.55, tone: 0x7CF4AB, world: { fog: 0.044, bloom: 0.86, motes: 0.9, exposure: 1.08 },
  },

  // ─── appendix placeholders ───────────────────────────────────────────────
  // Two reserved screens after the CTA. They carry real structure (heading,
  // slot list, kanji plate) but no content yet — filling one in is a normal
  // edit to its component, with no ledger or camera change needed. The camera
  // keeps swinging round to +Z and settles, so the pair reads as an epilogue
  // rather than more deck. Atmosphere cools and the bloom drops to say so.

  {
    id: 'appendix-a', weight: 1.05, num: '12', jp: '附録', code: 'SCR·12', title: 'APPENDIX A',
    sub: 'RESERVED · CONTENT PENDING',
    u: [0.748, 0.929, 0.533], yaw: 56, pitch: -4, w: 5.4, px: 1220, pxm: 750,
    fill: 0.76, lift: 0.26, tone: 0x5090D0, world: { fog: 0.036, bloom: 0.60, motes: 0.7, exposure: 1.0 },
  },

  {
    id: 'appendix-b', weight: 1.05, num: '13', jp: '補遺', code: 'SCR·13', title: 'APPENDIX B',
    sub: 'RESERVED · CONTENT PENDING',
    u: [-0.142, 0.553, 0.867], yaw: 8, pitch: 0, w: 5.4, px: 1220, pxm: 750,
    fill: 0.76, lift: 0.20, tone: 0x5090D0, world: { fog: 0.034, bloom: 0.56, motes: 0.66, exposure: 1.0 },
  },
] as const satisfies readonly Chapter[];

export type ChapterEntry = (typeof CHAPTERS)[number];
