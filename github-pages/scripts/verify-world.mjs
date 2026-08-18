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

// The deck's shape, mirrored from src/config/chapters.ts. This script cannot
// import the TS ledger, so these two are the one place it is restated — update
// them together with CHAPTERS, and every check below follows.
const ORDER = [
  'orientation', 'chaos', 'agent-harness', 'fleet-control', 'tasks', 'system-design',
  'skins', 'pipeline', 'themes', 'openspec', 'take-control', 'stats', 'alternatives', 'inspiration', 'advisors',
];
const SCREENS = ORDER.length;
const PAD = String(SCREENS).padStart(2, '0');

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
    spacerHeights: [...document.querySelectorAll('#scroll .chapter-spacer')].map((b) => b.style.height),
    screens: document.getElementById('roScreens')?.textContent,
    railCurrent: [...document.querySelectorAll('.sx-rail button')].map((b) => b.getAttribute('aria-current')),
  }));
  check('world boots into mode-3d', s.mode3d && !s.booting, `mode3d=${s.mode3d} booting=${s.booting}`);
  check(`all ${SCREENS} sections adopted as CSS3D panels`, s.panelsInCss3d === SCREENS && s.panelsInScroll === 0,
    `#css3d=${s.panelsInCss3d} #scroll=${s.panelsInScroll}`);
  check('exactly one canvas + one css3d host', s.canvases === 1 && s.css3dHosts === 1,
    `canvas=${s.canvases} css3d=${s.css3dHosts}`);
  check(`roScreens reports ${PAD}`, s.screens === PAD, String(s.screens));
  check('rail aria-current populated once 3D is live',
    s.railCurrent.filter((v) => v === 'true').length === 1 && s.railCurrent.every((v) => v !== null),
    JSON.stringify(s.railCurrent));

  // camera moves on scroll
  const before = await p.evaluate(() => document.getElementById('roProg')?.textContent);
  await p.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight * 0.45, behavior: 'instant' }));
  await p.waitForTimeout(1800);
  const after = await p.evaluate(() => document.getElementById('roProg')?.textContent);
  check('scroll drives the conductor', before !== after, `roProg ${before} -> ${after}`);

  const chapterNow = await p.evaluate(() => document.getElementById('sxChapterTitle')?.textContent);
  check('HUD chapter caption follows the chapter', chapterNow !== 'ORIENTATION', `title=${chapterNow}`);
  check('console clean in 3D', p._errors.length === 0, p._errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// ── 3b: in-panel controls are clickable in 3D (the panel hit relay) ────────
// Chromium refuses to hit-test #orientation/#agent-harness/#fleet-control, so the four fleet-control
// tabs and orientation's two anchors only respond via src/app/panelHitRelay.ts.
// Real mouse clicks at real screen coordinates are the only way to catch a
// regression here — all of these pass a DOM `.click()` assertion even when the
// page is completely dead to the pointer.
{
  const { ctx, p } = await page();
  await p.goto(URL_, { waitUntil: 'domcontentloaded' });
  await waitFor3D(p);
  await p.waitForTimeout(2000);

  const goTo = async (i) => {
    await p.evaluate((n) => [...document.querySelectorAll('.sx-rail button')][n].click(), i);
    await p.waitForTimeout(2800);
  };
  const clickCentre = async (sel) => {
    const c = await p.evaluate((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    }, sel);
    await p.mouse.click(c[0], c[1]);
    await p.waitForTimeout(400);
  };

  await goTo(3);
  const switched = [];
  for (const v of ['tasks', 'automation', 'usage', 'sessions']) {
    await clickCentre('#tab-' + v);
    switched.push(await p.evaluate((n) => document.getElementById('tab-' + n).getAttribute('aria-selected'), v));
  }
  check('all 4 fleet-control tabs switch on a real click in 3D', switched.every((v) => v === 'true'),
    JSON.stringify(switched));

  const probe = await p.evaluate(() => {
    const r = document.getElementById('tab-usage').getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  });
  await p.mouse.move(probe[0], probe[1]);
  const on = await p.evaluate(() => ({
    cursor: document.getElementById('gl').style.cursor,
    marked: document.getElementById('tab-usage').classList.contains('hit-hover'),
  }));
  await p.mouse.move(14, 886);
  const off = await p.evaluate(() => ({
    cursor: document.getElementById('gl').style.cursor,
    marked: document.querySelectorAll('.hit-hover').length,
  }));
  check('canvas shows a pointer cursor over relayed controls only',
    on.cursor === 'pointer' && off.cursor === '', `over=${on.cursor || 'none'} off=${off.cursor || 'none'}`);
  // :hover cannot be forced from script, so the relay marks its pick instead —
  // and must un-mark it, or a control stays lit after the pointer leaves.
  check('relayed hover is marked on the control and cleared on leave',
    on.marked && off.marked === 0, `marked=${on.marked} strandedAfterLeave=${off.marked}`);

  // Derived from each anchor's own href rather than hardcoded, so re-pointing
  // one of them (they have been re-pointed and relabelled before) does not fail
  // this check — what is under test is that the click lands at all.
  const expectedNum = (sel) => p.evaluate((s) => {
    const target = document.querySelector(s).getAttribute('href').slice(1);
    const panels = [...document.querySelectorAll('#css3d .chapter.as-panel')];
    return String(panels.findIndex((el) => el.id === target) + 1).padStart(2, '0');
  }, sel);
  const jump = async (sel) => {
    await goTo(0);
    const want = await expectedNum(sel);
    await clickCentre(sel);
    await p.waitForTimeout(2400);
    const got = await p.evaluate(() => document.getElementById('sxChapterNum').textContent);
    return { sel, want, got };
  };
  const jumps = [await jump('#orientation .btn.primary'), await jump('#orientationCta')];
  check('orientation anchors jump the conductor, not the URL fragment',
    jumps.every((j) => j.want !== '00' && j.got === j.want),
    jumps.map((j) => `${j.sel} -> ${j.got} (want ${j.want})`).join(', '));

  await goTo(4);
  const wf = await p.evaluate(() => {
    const b = [...document.querySelectorAll('#tasks .flow-item')][3];
    const r = b.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2, document.querySelector('#tasks .flow-item.now')?.dataset.step];
  });
  await p.mouse.click(wf[0], wf[1]);
  await p.waitForTimeout(500);
  const stepAfter = await p.evaluate(() => document.querySelector('#tasks .flow-item.now')?.dataset.step);
  check('a panel Chromium DOES hit-test is untouched by the relay', wf[2] === '0' && stepAfter === '3',
    `now step ${wf[2]} -> ${stepAfter}`);

  check('console clean while relaying clicks', p._errors.length === 0, p._errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// ── 4: pre-boot spacer sizing (optimistic boot) ─────────────────────────────
{
  const { ctx, p } = await page();
  // Stall the model so we can observe the loading state.
  await p.route('**/*.glb', async (r) => { await new Promise((res) => setTimeout(res, 6000)); r.abort(); });
  await p.goto(URL_, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  const s = await p.evaluate(() => ({
    booting: document.body.classList.contains('booting'),
    heights: [...document.querySelectorAll('#scroll .chapter-spacer')].map((b) => b.style.height),
    docHeight: document.documentElement.scrollHeight,
    vh: window.innerHeight,
  }));
  const sized = s.heights.every((h) => h && h.endsWith('px'));
  check('spacers sized BEFORE the model loads (optimistic boot)', s.booting && sized,
    `booting=${s.booting} heights=${JSON.stringify(s.heights)}`);
  check('document claims full scroll length while loading', s.docHeight > s.vh * SCREENS,
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
    spacerHeights: [...document.querySelectorAll('#scroll .chapter-spacer')].map((b) => b.style.height),
    err: document.getElementById('sxBootErr')?.className,
  }));
  check(`model 404 → flat deck, ${SCREENS} chapters back in #scroll`,
    !s.mode3d && !s.booting && s.headings === SCREENS, JSON.stringify(s));
  check('flat note revealed + error banner shown', s.flatNote && s.err?.includes('show'), `${s.flatNote} ${s.err}`);
  check('spacer heights unwound on failure', s.spacerHeights.every((h) => !h), JSON.stringify(s.spacerHeights));
  // fleet-control tabs still work in flat mode
  await p.click('#tab-tasks');
  await p.waitForTimeout(200);
  const tabs = await p.evaluate(() => ({
    sel: document.getElementById('tab-tasks')?.getAttribute('aria-selected'),
    vis: !document.getElementById('view-tasks')?.hidden,
  }));
  check('fleet-control tabs work in flat mode', tabs.sel === 'true' && tabs.vis, JSON.stringify(tabs));
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
    spacerHeights: [...document.querySelectorAll('#scroll .chapter-spacer')].map((b) => b.style.height),
    canvas: document.querySelectorAll('canvas#gl').length,
    flatNote: !document.getElementById('sxFlatNote')?.hidden,
    order: [...document.querySelectorAll('#scroll .chapter')].map((e) => e.id),
    orientationBox: (() => { const r = document.getElementById('orientation').getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
  }));
  check('context loss demotes to flat', !s.mode3d, `mode3d=${s.mode3d}`);
  check(`all ${SCREENS} sections restored into #scroll in order`,
    s.inScroll === SCREENS && s.order.join(',') === ORDER.join(','), s.order.join(','));
  // Assert the style attribute is EMPTY, not merely free of a listed subset —
  // the first version of this check whitelisted width/height/display/opacity
  // and sailed past a leftover CSS3DRenderer `transform: matrix3d(...)` that
  // rendered the restored deck completely blank.
  check('every world-owned inline style cleared (style attr empty)',
    s.asPanel === 0 && s.inlineStyles.every((v) => v.trim() === ''),
    `asPanel=${s.asPanel} styles=${JSON.stringify(s.inlineStyles)}`);
  check('spacer heights cleared on demotion', s.spacerHeights.every((h) => !h), JSON.stringify(s.spacerHeights));
  check('canvas removed on demotion', s.canvas === 0, `canvas=${s.canvas}`);
  check('flat note revealed after demotion', s.flatNote, String(s.flatNote));
  // The restored deck must occupy real layout space. A leftover CSS3D
  // transform collapses this to a few pixels while every DOM check still passes.
  check('restored deck has real on-screen geometry',
    s.orientationBox.w > 800 && s.orientationBox.h > 300, JSON.stringify(s.orientationBox));
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

// ── 9: scroll-driven in-chapter steps, the 2D/3D toggle, the autoplay tour ─
{
  const { ctx, p } = await page();
  await p.goto(URL_, { waitUntil: 'domcontentloaded' });
  await waitFor3D(p);
  await p.waitForTimeout(2000);

  // Longer than the other blocks' rail waits on purpose: this one measures the
  // panel's box, and easeSettle's approach is still creeping in at 2.5s.
  const railTo = async (i) => {
    await p.evaluate((n) => document.querySelectorAll('.sx-rail button')[n].click(), i);
    await p.waitForTimeout(4000);
  };
  // Walks a chapter's scroll and records the step sequence it produces. Small
  // hops on purpose: one that clears a whole chapter would pass while skipping
  // every band in between, which is the regression worth catching.
  const walk = async (read, hops) => {
    const seen = [await read()];
    for (let i = 0; i < hops; i++) {
      await p.evaluate(() => window.scrollBy(0, 240));
      await p.waitForTimeout(220);
      const now = await read();
      if (now !== seen[seen.length - 1]) seen.push(now);
    }
    return seen;
  };

  // The panel's own on-screen box, which is where the camera shows up: the
  // CSS3D transform is what moving/receding looks like in the DOM.
  const panelBox = (id) => p.evaluate((s) => {
    const r = document.getElementById(s).getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
  }, id);

  await railTo(3);
  const parkedBefore = await panelBox('fleet-control');
  const tabs = await walk(() => p.evaluate(() =>
    document.querySelector('.console-tabs .tab[aria-selected="true"]')?.dataset.view), 7);
  check('scroll walks the fleet-control tabs in order',
    JSON.stringify(tabs) === JSON.stringify(['sessions', 'tasks', 'automation', 'usage']),
    JSON.stringify(tabs));

  // The whole point of the dwell (createWorld's dwellProgress): stepping the
  // sub-views must not sail the panel being read out of frame.
  const parkedAfter = await panelBox('fleet-control');
  const drift = Math.max(Math.abs(parkedAfter.w - parkedBefore.w), Math.abs(parkedAfter.top - parkedBefore.top));
  const opacity = await p.evaluate(() => document.getElementById('fleet-control').style.opacity);
  // A few px of residual camera damping is expected; a chapter's worth of
  // travel is hundreds.
  check('camera parks while the sub-views are stepped', drift <= 20 && Number(opacity) > 0.95,
    `drift=${drift}px opacity=${opacity} ${JSON.stringify(parkedBefore)} -> ${JSON.stringify(parkedAfter)}`);

  await railTo(4);
  const steps = await walk(() => p.evaluate(() =>
    document.querySelector('.flow .flow-item.now')?.dataset.step), 7);
  check('scroll walks the tasks flow in order',
    JSON.stringify(steps) === JSON.stringify(['0', '1', '2', '3', '4']), JSON.stringify(steps));

  const caption = () => p.evaluate(() => document.getElementById('sxNote')?.textContent);
  const autoBtn = 'button[aria-label="Toggle the hands-free tour"]';
  await railTo(0);
  const before = await caption();
  await p.click(autoBtn);
  // Sampled, not just start-vs-end: the tour must SCROLL between stops, and a
  // jump would land in one or two frames. Anything animated leaves a trail of
  // distinct offsets behind it.
  const offsets = new Set();
  for (let i = 0; i < 90; i++) {
    offsets.add(await p.evaluate(() => Math.round(window.scrollY)));
    await p.waitForTimeout(100);
  }
  check('autoplay advances the chapter unattended', before !== (await caption()),
    `${before} -> ${await caption()}`);
  check('autoplay scrolls between stops rather than jumping', offsets.size > 12,
    `${offsets.size} distinct offsets sampled`);
  await p.click(autoBtn);
  const stopped = await caption();
  await p.waitForTimeout(9000);
  check('autoplay stops when switched off', (await caption()) === stopped, stopped);

  const modeBtn = 'button[aria-label="Toggle the 3D walkthrough"]';
  await p.click(modeBtn);
  await p.waitForTimeout(600);
  const flat = await p.evaluate(() => ({
    mode3d: document.body.classList.contains('mode-3d'),
    inScroll: document.querySelectorAll('#scroll .chapter').length,
    canvas: document.querySelectorAll('canvas#gl').length,
    label: document.querySelector('button[aria-label="Toggle the 3D walkthrough"] b')?.textContent,
  }));
  check('MODE 2D restores the flat deck',
    !flat.mode3d && flat.inScroll === SCREENS && flat.canvas === 0 && flat.label === '2D',
    JSON.stringify(flat));

  await p.click(modeBtn);
  await waitFor3D(p);
  await p.waitForTimeout(2500);
  const back = await p.evaluate(() => ({
    panels: document.querySelectorAll('#css3d .chapter.as-panel').length,
    canvas: document.querySelectorAll('canvas#gl').length,
    label: document.querySelector('button[aria-label="Toggle the 3D walkthrough"] b')?.textContent,
  }));
  check('MODE 3D rebuilds the world', back.panels === SCREENS && back.canvas === 1 && back.label === '3D',
    JSON.stringify(back));
  check('console clean across toggles and the tour', p._errors.length === 0, p._errors.slice(0, 3).join(' | '));
  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
