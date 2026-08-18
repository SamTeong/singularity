// Throwaway: parks the camera on each chapter and screenshots it. This deck's
// history is explicit that every real bug in the original build was found by
// looking at rendered output and none by DOM assertions.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright-core');

const URL_ = process.env.APP_URL ?? 'http://localhost:4319/';
const OUT = new URL('./.shots/', import.meta.url).pathname;
const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const ONLY = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const W = Number(process.env.W ?? 1440);
const H = Number(process.env.H ?? 900);

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: GL });
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
const p = await ctx.newPage();
const errors = [];
p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await p.goto(URL_ + (process.env.DBG ? '?debug' : ''), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.body.classList.contains('mode-3d'), null, { timeout: 120000 });
await p.waitForTimeout(2500);

const ids = await p.evaluate(() => [...document.querySelectorAll('#css3d .chapter')].map((e) => e.id));
console.log('panels:', ids.join(', '));

// The rail is the deck's own goTo(); scroll-anchored, so it lands exactly on
// the waypoint rather than somewhere between two.
const railCount = await p.evaluate(() => document.querySelectorAll('.sx-rail button').length);
for (let i = 0; i < railCount; i++) {
  const id = ids[i] ?? String(i);
  if (ONLY.length && !ONLY.includes(id)) continue;
  await p.evaluate((n) => document.querySelectorAll('.sx-rail button')[n].click(), i);
  await p.waitForTimeout(2600); // smooth scroll + damped camera settle
  const info = await p.evaluate(() => ({
    beat: document.querySelector('.sx-beat h2')?.textContent,
    idx: document.querySelector('.sx-beat .idx b')?.textContent,
    prog: document.getElementById('roProg')?.textContent,
  }));
  await p.screenshot({ path: `${OUT}${String(i).padStart(2, '0')}-${id}.png` });
  console.log(`${String(i).padStart(2, '0')} ${id.padEnd(11)} hud=${info.idx} ${info.beat}  prog=${info.prog}`);
}

console.log(errors.length ? `\nCONSOLE ERRORS:\n${errors.join('\n')}` : '\nconsole clean');
await browser.close();
