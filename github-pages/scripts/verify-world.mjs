/**
 * Phase 5 verification — drives the real 3D experience headlessly.
 *
 * playwright-core lives in the ROOT repo's node_modules and is CommonJS, so the
 * named ESM import throws; createRequire keeps that explicit.
 */
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright-core');

const URL_ = process.env.APP_URL ?? 'http://localhost:4319/';
const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({ args: GL });

async function page(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
  const p = await ctx.newPage();
  p._errors = [];
  p.on('console', (m) => { if (m.type() === 'error') p._errors.push(m.text()); });
  p.on('pageerror', (e) => p._errors.push('pageerror: ' + e.message));
  return { ctx, p };
}

const waitFor3D = (p) => p.waitForFunction(() => document.body.classList.contains('mode-3d'), null, { timeout: 90000 });

// ── 1-3: the world actually boots, panels mount, console is clean ──────────
{
  const { ctx, p } = await page();
  await p.goto(URL_, { waitUntil: 'domcontentloaded' });
  await waitFor3D(p);
  await p.waitForTimeout(2500);

  const s = await p.evaluate(() => ({
    mode3d: document.body.classList.contains('mode-3d'),
    booting: document.body.classList.contains('booting'),
    canvases: document.querySelectorAll('canvas#gl').length,
    css3dHosts: document.querySelectorAll('div#css3d').length,
    panelsInCss3d: document.querySelectorAll('#css3d .chapter.as-panel').length,
    panelsInScroll: document.querySelectorAll('#scroll .chapter').length,
    beatHeights: [...document.querySelectorAll('#scroll .beat')].map((b) => b.style.height),
    screens: document.getElementById('roScreens')?.textContent,
    railCurrent: [...document.querySelectorAll('.sx-rail button')].map((b) => b.getAttribute('aria-current')),
  }));
  check('world boots into mode-3d', s.mode3d && !s.booting, `mode3d=${s.mode3d} booting=${s.booting}`);
  check('all 7 sections adopted as CSS3D panels', s.panelsInCss3d === 7 && s.panelsInScroll === 0,
    `#css3d=${s.panelsInCss3d} #scroll=${s.panelsInScroll}`);
  check('exactly one canvas + one css3d host', s.canvases === 1 && s.css3dHosts === 1,
    `canvas=${s.canvases} css3d=${s.css3dHosts}`);
  check('roScreens reports 07', s.screens === '07', String(s.screens));
  check('rail aria-current populated once 3D is live',
    s.railCurrent.filter((v) => v === 'true').length === 1 && s.railCurrent.every((v) => v !== null),
    JSON.stringify(s.railCurrent));

  // camera moves on scroll
  const before = await p.evaluate(() => document.getElementById('roProg')?.textContent);
  await p.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight * 0.45, behavior: 'instant' }));
  await p.waitForTimeout(1800);
  const after = await p.evaluate(() => document.getElementById('roProg')?.textContent);
  check('scroll drives the conductor', before !== after, `roProg ${before} -> ${after}`);

  const chapterNow = await p.evaluate(() => document.getElementById('sxBeatTitle')?.textContent);
  check('HUD beat caption follows the chapter', chapterNow !== 'ORIENTATION', `title=${chapterNow}`);
  check('console clean in 3D', p._errors.length === 0, p._errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// ── 4: pre-boot beat sizing (optimistic boot) ─────────────────────────────
{
  const { ctx, p } = await page();
  // Stall the model so we can observe the loading state.
  await p.route('**/*.glb', async (r) => { await new Promise((res) => setTimeout(res, 6000)); r.abort(); });
  await p.goto(URL_, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  const s = await p.evaluate(() => ({
    booting: document.body.classList.contains('booting'),
    heights: [...document.querySelectorAll('#scroll .beat')].map((b) => b.style.height),
    docHeight: document.documentElement.scrollHeight,
    vh: window.innerHeight,
  }));
  const sized = s.heights.every((h) => h && h.endsWith('px'));
  check('beats sized BEFORE the model loads (optimistic boot)', s.booting && sized,
    `booting=${s.booting} heights=${JSON.stringify(s.heights)}`);
  check('document claims full scroll length while loading', s.docHeight > s.vh * 7,
    `docHeight=${s.docHeight} vh=${s.vh}`);
  await ctx.close();
}

// ── 5: model 404 → flat deck ──────────────────────────────────────────────
{
  const { ctx, p } = await page();
  await p.route('**/*.glb', (r) => r.abort());
  await p.goto(URL_, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  const s = await p.evaluate(() => ({
    mode3d: document.body.classList.contains('mode-3d'),
    booting: document.body.classList.contains('booting'),
    flatNote: !document.getElementById('sxFlatNote')?.hidden,
    headings: document.querySelectorAll('#scroll .chapter').length,
    beatHeights: [...document.querySelectorAll('#scroll .beat')].map((b) => b.style.height),
    err: document.getElementById('sxBootErr')?.className,
  }));
  check('model 404 → flat deck, 7 chapters back in #scroll',
    !s.mode3d && !s.booting && s.headings === 7, JSON.stringify(s));
  check('flat note revealed + error banner shown', s.flatNote && s.err?.includes('show'), `${s.flatNote} ${s.err}`);
  check('beat heights unwound on failure', s.beatHeights.every((h) => !h), JSON.stringify(s.beatHeights));
  // cockpit tabs still work in flat mode
  await p.click('#tab-tasks');
  await p.waitForTimeout(200);
  const tabs = await p.evaluate(() => ({
    sel: document.getElementById('tab-tasks')?.getAttribute('aria-selected'),
    vis: !document.getElementById('view-tasks')?.hidden,
  }));
  check('cockpit tabs work in flat mode', tabs.sel === 'true' && tabs.vis, JSON.stringify(tabs));
  await ctx.close();
}

// ── 6: webglcontextlost demotes 3d → flat, DOM restored ───────────────────
{
  const { ctx, p } = await page();
  await p.goto(URL_, { waitUntil: 'domcontentloaded' });
  await waitFor3D(p);
  await p.waitForTimeout(2000);
  await p.evaluate(() => {
    const c = document.querySelector('canvas#gl');
    c.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  });
  await p.waitForTimeout(1500);
  const s = await p.evaluate(() => ({
    mode3d: document.body.classList.contains('mode-3d'),
    inScroll: document.querySelectorAll('#scroll .chapter').length,
    asPanel: document.querySelectorAll('.chapter.as-panel').length,
    inlineStyles: [...document.querySelectorAll('#scroll .chapter')].map((e) => e.getAttribute('style') || ''),
    beatHeights: [...document.querySelectorAll('#scroll .beat')].map((b) => b.style.height),
    canvas: document.querySelectorAll('canvas#gl').length,
    flatNote: !document.getElementById('sxFlatNote')?.hidden,
    order: [...document.querySelectorAll('#scroll .chapter')].map((e) => e.id),
    heroBox: (() => { const r = document.getElementById('hero').getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
  }));
  check('context loss demotes to flat', !s.mode3d, `mode3d=${s.mode3d}`);
  check('all 7 sections restored into #scroll in order',
    s.inScroll === 7 && s.order.join(',') === 'hero,problem,control,workflow,systems,local,boot', s.order.join(','));
  // Assert the style attribute is EMPTY, not merely free of a listed subset —
  // the first version of this check whitelisted width/height/display/opacity
  // and sailed past a leftover CSS3DRenderer `transform: matrix3d(...)` that
  // rendered the restored deck completely blank.
  check('every world-owned inline style cleared (style attr empty)',
    s.asPanel === 0 && s.inlineStyles.every((v) => v.trim() === ''),
    `asPanel=${s.asPanel} styles=${JSON.stringify(s.inlineStyles)}`);
  check('beat heights cleared on demotion', s.beatHeights.every((h) => !h), JSON.stringify(s.beatHeights));
  check('canvas removed on demotion', s.canvas === 0, `canvas=${s.canvas}`);
  check('flat note revealed after demotion', s.flatNote, String(s.flatNote));
  // The restored deck must occupy real layout space. A leftover CSS3D
  // transform collapses this to a few pixels while every DOM check still passes.
  check('restored deck has real on-screen geometry',
    s.heroBox.w > 800 && s.heroBox.h > 300, JSON.stringify(s.heroBox));
  const bad = p._errors.filter((e) => /NotFoundError|removeChild|insertBefore|panel-contract/.test(e));
  check('no NotFoundError / contract violation during demotion', bad.length === 0, bad.join(' | '));
  await ctx.close();
}

// ── 7: narrow viewport → flat, Three.js chunk never requested ─────────────
{
  const ctx = await browser.newContext({ viewport: { width: 800, height: 900 } });
  const p = await ctx.newPage();
  const requested = [];
  p.on('request', (r) => requested.push(r.url()));
  await p.goto(URL_, { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  const s = await p.evaluate(() => ({
    mode3d: document.body.classList.contains('mode-3d'),
    note: document.getElementById('sxFlatNote')?.textContent?.trim(),
    hidden: document.getElementById('sxFlatNote')?.hidden,
  }));
  const three = requested.filter((u) => /createWorld|three/i.test(u));
  const glb = requested.filter((u) => u.endsWith('.glb'));
  check('narrow viewport serves flat deck', !s.mode3d, `mode3d=${s.mode3d}`);
  check('narrow flat-note copy used', !s.hidden && /WIDER VIEWPORT/.test(s.note ?? ''), s.note);
  check('Three.js chunk never requested in flat mode', three.length === 0 && glb.length === 0,
    `three=${three.length} glb=${glb.length}`);
  await ctx.close();
}

// ── 8: ?debug ─────────────────────────────────────────────────────────────
{
  const { ctx, p } = await page();
  await p.goto(URL_ + '?debug', { waitUntil: 'domcontentloaded' });
  await waitFor3D(p);
  await p.waitForTimeout(2500);
  const s = await p.evaluate(() => ({
    dbg: document.body.classList.contains('dbg'),
    dbgVisible: getComputedStyle(document.getElementById('sxDbg')).display !== 'none',
    railHidden: getComputedStyle(document.querySelector('.sx-rail')).display === 'none',
    text: document.getElementById('sxDbg')?.textContent?.slice(0, 40),
  }));
  check('?debug shows overlay and hides rail', s.dbg && s.dbgVisible && s.railHidden, JSON.stringify(s));
  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
