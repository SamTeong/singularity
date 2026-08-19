// Static fixtures for the PIPELINE chapter (deck section 08). Pure data —
// no DOM, no timers, no React. Transcribed from docs/one-shot/slides/index.html,
// the STEPS array at L724-759 and TOKENS at L761-766.
//
// Two deviations from the source:
//
//  - Every path is built through `import.meta.env.BASE_URL`. The source is a
//    file:// one-shot using bare relative paths ("refs/thumbs/x.jpg"); this
//    app deploys to a GitHub Pages project subpath, where a bare relative path
//    resolves against the current ROUTE rather than the app root and 404s.
//  - The source's `desc` is an HTML string set via innerHTML, and two entries
//    embed a <code> tag. Restructured into typed [text, code] runs so the
//    stage description renders without dangerouslySetInnerHTML.

const REFS = `${import.meta.env.BASE_URL}refs/`;
const THUMBS = `${REFS}thumbs/`;

/** A run of stage-description text; `code` renders inside a <code> element. */
export type DescRun = { readonly text: string } | { readonly code: string };

export interface PipelineItem {
  label: string;
  /** Thumbnail. Absent/failed images fall back to a captioned placeholder
   *  plate rather than a broken-image glyph — see Pipeline.tsx. */
  img: string;
  /** The real artefact the lightbox opens. */
  src: string;
  kind: 'video' | 'page';
  tag: string;
  /** Video only: the frame the thumbnail was cut from, in seconds. */
  at?: number;
  /** Spans the full gallery width. */
  wide?: boolean;
}

export interface PipelineStep {
  n: string;
  jp: string;
  title: string;
  /** 1 = shipped (mint node), 0 = the stage you are standing in (orange). */
  done: 0 | 1;
  v: string;
  k: string;
  /** Marks the stage with the YOU ARE HERE flag. */
  here?: boolean;
  desc: readonly DescRun[];
  items: readonly PipelineItem[];
  /** Renders the Phosphor token swatches instead of a card grid. */
  swatches?: boolean;
}

const experiment = (i: number): PipelineItem => {
  const slug = `experiment-${String(i).padStart(2, '0')}`;
  return { label: slug.toUpperCase(), img: `${THUMBS}${slug}.jpg`, src: `${REFS}${slug}.html`, kind: 'page', tag: 'EXP' };
};

const layout = (label: string, slug: string, tag: string): PipelineItem => ({
  label,
  img: `${THUMBS}${slug}.jpg`,
  src: `${REFS}${slug}.html`,
  kind: 'page',
  tag,
});

export const PIPELINE_STEPS: readonly PipelineStep[] = [
  {
    n: '01', jp: '映像', title: 'VIDEO REFERENCES', done: 1, v: '23', k: 'CLIPS',
    desc: [
      {
        text: "90's-anime references — Evangelion mostly — gathered before writing a single prompt. Phosphor mint on void black, safety orange, blood red: it all comes from here. Six stills below; click one to play the clip it was pulled from.",
      },
    ],
    items: [
      { label: 'BORDER LINE', img: `${THUMBS}ref-01-border-line.jpg`, src: `${REFS}video/T5XfB2K.mp4`, at: 0.05, kind: 'video', tag: 'NGE' },
      { label: 'CIRCUIT MAP', img: `${THUMBS}ref-02-circuit.jpg`, src: `${REFS}video/UaCQJdl.mp4`, at: 0.05, kind: 'video', tag: 'NGE' },
      { label: 'GAUGE COLUMNS', img: `${THUMBS}ref-03-gauges.jpg`, src: `${REFS}video/UaCQJdl.mp4`, at: 1.6, kind: 'video', tag: 'NGE' },
      { label: 'CHEVRON GRID', img: `${THUMBS}ref-04-chevrons.jpg`, src: `${REFS}video/T5XfB2K.mp4`, at: 0.6, kind: 'video', tag: 'NGE' },
      { label: 'GEOFRONT 予想図', img: `${THUMBS}ref-05-geofront.jpg`, src: `${REFS}video/y4MaTw6.mp4`, at: 0.6, kind: 'video', tag: 'NGE' },
      { label: 'UNIT READOUT', img: `${THUMBS}ref-06-unit.jpg`, src: `${REFS}video/T5XfB2K.mp4`, at: 1.6, kind: 'video', tag: 'NGE' },
    ],
  },
  {
    n: '02', jp: '実験', title: 'EXPERIMENTS', done: 1, v: '34', k: 'HTML PAGES',
    desc: [
      { code: '/frontend-design' },
      { text: ' and ' },
      { code: '/impeccable' },
      { text: ' generate the first UI passes off those references. Most get thrown away — that’s the point.' },
    ],
    items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 11].map(experiment),
  },
  {
    n: '03', jp: '配置', title: 'SAMPLE LAYOUTS', done: 1, v: '08', k: 'ONE-SHOTS',
    desc: [
      { text: 'Eight layouts, built far enough to see which direction was actually working — dashboards, forms, landing pages, a wiki.' },
    ],
    items: [
      layout('DASHBOARD 01', 'dashboard-01', 'DASH'),
      layout('DASHBOARD 02', 'dashboard-02', 'DASH'),
      layout('DASHBOARD 03', 'dashboard-03', 'DASH'),
      layout('FORM 01', 'form-01', 'FORM'),
      layout('FORM 02', 'form-02', 'FORM'),
      layout('LANDING PAGE 01', 'landing-page-01', 'LAND'),
      layout('LANDING PAGE 02', 'landing-page-02', 'LAND'),
      layout('WIKI', 'wiki', 'WIKI'),
    ],
  },
  {
    n: '04', jp: '体系', title: 'DESIGN SYSTEM', done: 1, v: '2', k: 'ARTIFACTS',
    desc: [
      { code: '/design-system' },
      { text: ' extracts a design-system.html and a DESIGN-SYSTEM.md from whichever layouts survive. Tokens, atoms, patterns — one source' },
    ],
    items: [
      { label: 'DESIGN-SYSTEM.HTML', img: `${THUMBS}design-system.jpg`, src: `${REFS}design-system.html`, kind: 'page', tag: 'SYS', wide: true },
    ],
  },
  {
    n: '05', jp: '主題', title: 'MUI THEME', done: 0, v: '01', k: 'SHIPPED', here: true,
    desc: [
      { code: '/material-ui-theming' },
      { text: ' turns the design system into Phosphor — dark-mode only. These are the tokens that came out the other end.' },
    ],
    items: [],
    swatches: true,
  },
];

/** Source L761-766 — the Phosphor token set, shown as swatches on stage 05.
 *  Every hex here is also a `--var` in src/styles/tokens.css; the duplication
 *  is the point, because the swatch grid is a printed inventory of the theme,
 *  not a live readout of it. */
export const PHOSPHOR_TOKENS: readonly (readonly [string, string])[] = [
  ['BG / VOID', '#0A0A0A'],
  ['MINT', '#52F29A'],
  ['MINT-HI', '#7CF4AB'],
  ['GREEN-MAP', '#3C9C6C'],
  ['GREEN-DIM', '#246C3C'],
  ['PAPER', '#EDF8D6'],
  ['ORANGE', '#F26400'],
  ['AMBER', '#F49F09'],
  ['AMBER-DIM', '#9C3C24'],
  ['RED', '#C20C0C'],
  ['RED-HI', '#E2280F'],
  ['CRIMSON', '#E60225'],
  ['TEAL', '#0C6C80'],
  ['BLUE', '#5090D0'],
];
