// Transcribed from docs/one-shot/3d/sample-gitlab-3d-scan.html, source lines
// 750-785 (the CHAPTER_LEDGER). Two deliberate deviations from that shape:
//
//  - `el: '#hero'` (a selector string) becomes `elementId: 'hero'` (a typed
//    SectionId union) — `id` and `elementId` genuinely differ for chapter 1
//    ('arrival' vs 'hero'), so both fields are kept.
//  - `weight` is new: it is the `data-weight` attribute on each chapter's
//    `.beat` wrapper in the source markup (lines 499, 524, 551, 633, 650,
//    669, 694). It moves into the ledger because the scroll conductor pairs
//    beats and chapters positionally — keeping the order in two places lets
//    them silently drift.

export type ChapterId = 'arrival' | 'problem' | 'control' | 'workflow' | 'systems' | 'local' | 'boot';
export type SectionId = 'hero' | 'problem' | 'control' | 'workflow' | 'systems' | 'local' | 'boot';

export interface ChapterWorld {
  fog: number; // FogExp2 density
  bloom: number; // UnrealBloomPass strength
  motes: number; // mote opacity multiplier
  exposure: number; // renderer.toneMappingExposure
}

export interface Chapter {
  id: ChapterId;
  elementId: SectionId;
  weight: number; // beat height in viewport heights
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
    id: 'arrival', elementId: 'hero', weight: 1.30, num: '01', jp: '到着', code: 'SCR·01', title: 'ORIENTATION',
    sub: 'THE CONTROL PLANE, STATED PLAINLY',
    u: [1.52, 0.53, 0.36], yaw: 78, pitch: 0, w: 5.8, px: 1240, pxm: 760,
    fill: 0.64, lift: 0.35, tone: 0x52F29A, world: { fog: 0.052, bloom: 0.62, motes: 0.85, exposure: 1.06 },
  },

  {
    id: 'problem', elementId: 'problem', weight: 1.10, num: '02', jp: '混沌', code: 'SCR·02', title: 'AGENT SPRAWL',
    sub: 'SEVEN TERMINALS, NO SHARED PICTURE',
    u: [0.62, 0.76, 0.88], yaw: 32, pitch: -4, w: 5.6, px: 1240, pxm: 760,
    fill: 0.84, lift: 0.15, tone: 0xE2280F, world: { fog: 0.040, bloom: 0.58, motes: 0.7, exposure: 1.02 },
  },

  {
    id: 'control', elementId: 'control', weight: 1.85, num: '03', jp: '制御', code: 'SCR·03', title: 'FLEET CONTROL',
    sub: 'ONE LIVE DECK · SESSIONS · TASKS · AUTOMATION · USAGE',
    u: [-0.87, 0.475, -0.10], yaw: 90, pitch: 0, w: 6.4, px: 1460, pxm: 780,
    fill: 0.92, lift: 0.05, tone: 0xF26400, world: { fog: 0.026, bloom: 0.74, motes: 0.5, exposure: 1.0 },
  },

  {
    id: 'workflow', elementId: 'workflow', weight: 1.20, num: '04', jp: '流程', code: 'SCR·04', title: 'WORK MOVES',
    sub: 'SPEC → TASK → WORKTREE → AGENT → REVIEW',
    u: [0.64, 0.42, 0.85], yaw: 176, pitch: 0, w: 5.9, px: 1340, pxm: 760,
    fill: 0.90, lift: 0.10, tone: 0x0C6C80, world: { fog: 0.028, bloom: 0.66, motes: 0.55, exposure: 1.0 },
  },

  {
    id: 'systems', elementId: 'systems', weight: 1.75, num: '05', jp: '系統', code: 'SCR·05', title: 'THE SURROUNDING SYSTEMS',
    sub: 'EIGHT OPERATIONAL SURFACES AROUND THE WORK',
    u: [-0.84, 0.755, 0.44], yaw: 96, pitch: 6, w: 6.2, px: 1420, pxm: 770,
    fill: 0.92, lift: 0.10, tone: 0x5090D0, world: { fog: 0.024, bloom: 0.70, motes: 0.5, exposure: 1.0 },
  },

  {
    id: 'local', elementId: 'local', weight: 1.30, num: '06', jp: '局所', code: 'SCR·06', title: 'LOCAL-FIRST',
    sub: 'YOUR MACHINE · YOUR STATE · YOUR AGENTS',
    u: [0.04, 0.40, -0.80], yaw: 4, pitch: 0, w: 5.8, px: 1320, pxm: 760,
    fill: 0.78, lift: 0.30, tone: 0x52F29A, world: { fog: 0.032, bloom: 0.68, motes: 0.7, exposure: 1.02 },
  },

  {
    id: 'boot', elementId: 'boot', weight: 1.30, num: '07', jp: '開始', code: 'SCR·07', title: 'TAKE CONTROL',
    sub: 'CLONE · BOOTSTRAP · START',
    u: [1.16, 1.08, -0.42], yaw: 116, pitch: -6, w: 5.2, px: 1140, pxm: 750,
    fill: 0.72, lift: 0.55, tone: 0x7CF4AB, world: { fog: 0.044, bloom: 0.86, motes: 0.9, exposure: 1.08 },
  },
] as const satisfies readonly Chapter[];

export type ChapterEntry = (typeof CHAPTERS)[number];
