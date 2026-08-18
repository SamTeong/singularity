/**
 * Phase 2 parity harness — compares the React port against the original
 * one-shot's FLAT fallback.
 *
 * playwright-core is CommonJS: the named import throws, so default-import then
 * destructure. SwiftShader flags are needed because this box has no GPU in the
 * headless context; FPS numbers under it are meaningless and are not measured.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

// Resolved from the ROOT repo's node_modules — this app deliberately does not
// depend on playwright itself. createRequire keeps that explicit and survives a
// reinstall, unlike a symlink into the local node_modules.
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright-core');

const ORIG = 'http://127.0.0.1:8080/one-shot/3d/sample-gitlab-3d-scan.html';
const PORT = 'http://localhost:4319/';
// The port renamed every chapter after its title (one kebab-case key per
// chapter, used as id + `.chapter` modifier + stylesheet name), so the two
// sides no longer share ids: fingerprint/box diffs on those names are
// expected, and the screenshot walk needs one list per side.
const ORIG_CHAPTERS = ['hero', 'problem', 'control', 'workflow', 'systems', 'local', 'boot'];
const PORT_CHAPTERS = ['orientation', 'chaos', 'fleet-control', 'tasks', 'agent-harness', 'system-design', 'take-control'];
const OUT = 'scripts/.parity';

/* Both pages must be put into the same visual state before comparing:
   - the original reaches flat mode via fail() when the .glb is aborted, which
     leaves #sxFlatNote visible and hides #sxBoot only after 9s;
   - the port has no Three.js at all, so its #sxBoot is still visible and its
     #sxFlatNote still hidden (Phase 5 owns both).
   Normalising here isolates the deck itself, which is what Phase 2 delivered. */
const NORMALISE = () => {
  document.getElementById('sxBoot')?.setAttribute('hidden', '');
  document.getElementById('sxFlatNote')?.removeAttribute('hidden');
};

/** Structural fingerprint: tag + id + sorted classes + attrs, depth-first. */
const FINGERPRINT = () => {
  const skip = new Set(['sxBoot', 'sxFlatNote']);
  const out = [];
  const walk = (el, d) => {
    if (skip.has(el.id)) return;
    const attrs = [...el.attributes]
      .filter((a) => !['style', 'class', 'id'].includes(a.name))
      .map((a) => `${a.name}=${a.value}`)
      .sort();
    out.push(
      `${'  '.repeat(d)}${el.tagName.toLowerCase()}` +
        `${el.id ? '#' + el.id : ''}` +
        `${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).sort().join('.') : ''}` +
        `${attrs.length ? ' [' + attrs.join(' ') + ']' : ''}`,
    );
    for (const c of el.children) walk(c, d + 1);
  };
  walk(document.body, 0);
  return out;
};

/** Layout boxes for every element carrying an id or a class, keyed stably. */
const BOXES = () => {
  const r = {};
  let n = 0;
  for (const el of document.querySelectorAll('#scroll *')) {
    const key = el.id || `${el.tagName}.${(el.className || '').toString().trim().split(/\s+/)[0]}#${n++}`;
    r[key] = [el.offsetTop, el.offsetLeft, el.offsetWidth, el.offsetHeight];
  }
  return r;
};

async function capture(browser, url, label, width, height, { abortGlb = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  if (abortGlb) await page.route('**/*.glb', (r) => r.abort());

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(abortGlb ? 1500 : 800);
  await page.evaluate(NORMALISE);
  await page.waitForTimeout(200);

  const dir = `${OUT}/${width}x${height}`;
  mkdirSync(dir, { recursive: true });

  const shots = [];
  for (const id of label === 'orig' ? ORIG_CHAPTERS : PORT_CHAPTERS) {
    await page.evaluate((i) => document.getElementById(i)?.scrollIntoView({ block: 'center', behavior: 'instant' }), id);
    await page.waitForTimeout(150);
    const f = `${dir}/${label}-${id}.png`;
    await page.screenshot({ path: f });
    shots.push(f);
  }

  const fingerprint = await page.evaluate(FINGERPRINT);
  const boxes = await page.evaluate(BOXES);
  const probes = await page.evaluate(() => ({
    installLines: document.getElementById('installCommand')?.textContent.split('\n').length ?? -1,
    installHeight: document.getElementById('installCommand')?.offsetHeight ?? -1,
    marqueeSpans: document.querySelectorAll('.marquee-track span').length,
    tonesResolved: [...document.querySelectorAll('[style*="--tone"]')].map(
      (e) => getComputedStyle(e).getPropertyValue('--tone').trim(),
    ),
    scrollerIsDoc: document.scrollingElement === document.documentElement,
    rootStyle: (() => {
      const r = document.getElementById('root');
      if (!r) return 'no #root (original)';
      const s = getComputedStyle(r);
      return ['transform', 'filter', 'opacity', 'contain', 'overflow', 'height']
        .map((p) => `${p}:${s[p]}`).join(' ');
    })(),
    ariaHiddenFalse: [...document.querySelectorAll('[aria-hidden="false"]')].map((e) => e.id || e.tagName),
    hiddenTabpanels: [...document.querySelectorAll('.view')].map((e) => `${e.id}:${e.hasAttribute('hidden')}`),
    tabAttrs: [...document.querySelectorAll('.tab')].map((e) => `${e.id} sel=${e.getAttribute('aria-selected')} ti=${e.getAttribute('tabindex')}`),
    railAriaCurrent: [...document.querySelectorAll('.sx-rail button')].map((e) => e.getAttribute('aria-current')),
    topbarLinks: [...document.querySelectorAll('.sx-links a')].map((e) => e.textContent),
    glyphs: (() => {
      const t = document.body.innerText;
      const set = '特異点 走査甲板 到着 混沌 制御 流程 系統 局所 開始 会話 任務 自動 消費 統 · ↗ → ◉ ∞ …'.split(' ');
      return Object.fromEntries(set.map((g) => [g, (t.match(new RegExp(g, 'g')) || []).length]));
    })(),
    chapterCount: document.querySelectorAll('#scroll .chapter').length,
    // `.beat` is the original's name for the wrapper the port calls `.chapter-spacer`.
    spacerCount: document.querySelectorAll('#scroll .chapter-spacer, #scroll .beat').length,
  }));

  await ctx.close();
  return { shots, fingerprint, boxes, probes, errors };
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const report = {};
for (const [w, h] of [[1440, 900], [1024, 768]]) {
  // Both sides get the model aborted: that is what puts the ORIGINAL into its
  // flat fallback, and since Phase 5 the port boots into 3D by default, so it
  // needs the same treatment to be comparable. This harness compares the FLAT
  // deck; scripts/verify-world.mjs is what exercises the 3D experience.
  const orig = await capture(browser, ORIG, 'orig', w, h, { abortGlb: true });
  const port = await capture(browser, PORT, 'port', w, h, { abortGlb: true });
  report[`${w}x${h}`] = { orig, port };
}
await browser.close();

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log('wrote', `${OUT}/report.json`);
