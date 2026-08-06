// Phosphor Console shell spec (task 8.2): focused assertions that the shell
// actually renders the NERV/MAGI command-console grammar described by
// `openspec/changes/implement-phosphor-theme/specs/phosphor-console-appearance/
// spec.md` and `design.md` D1/D5 — not just that it fails to crash (console.spec.mjs
// already proves that, across every view × both skins).
//
// Concrete values asserted below (orange #F26400, mint #52F29A, void #0A0A0A,
// frame border width 3px) come straight from the vendored `phosphor-console-theme`
// package (`theme/tokens.ts`) and the app's own role mapping
// (`web/src/theme/skins/phosphor.roles.js`) — not invented numbers — so a real
// regression in either moves these, not a copy-paste guess. The destructive
// "Restart server" row is checked structurally (red-dominant, not mint/orange)
// rather than against `PHOSPHOR_ERROR_AA` (`web/src/theme/skins/phosphor.jsx`)
// verbatim — MUI's cssVariables dark-scheme generation resolves
// `--mui-palette-error-main` to a different (also AA/AAA-passing) red at
// runtime than that literal; see this file's final report for the full trace.
import { test, expect } from './fixtures/test.mjs';
import { goto, openMenu, setSkin } from './helpers/nav.mjs';

test.setTimeout(60000);

const ORANGE = 'rgb(242, 100, 0)';
const MINT = 'rgb(82, 242, 154)';
const VOID = 'rgb(10, 10, 10)';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await setSkin(page, 'Phosphor Console');
});

test('frame and masthead render the orange double-border command console with no glass blur or drop elevation', async ({ page }) => {
  await goto(page, 'Tasks');

  const masthead = page.getByRole('banner');
  await expect(masthead).toBeVisible();
  await expect(masthead.getByText('FLEET CONTROL PLANE')).toBeVisible();
  await expect(masthead.getByText('SINGULARITY')).toBeVisible(); // Monogram caption

  // The frame is PhosphorFrame's own Box, the masthead's immediate parent —
  // see AppShell.jsx: `<PhosphorFrame masthead={<PhosphorMasthead .../>}>`.
  const frame = masthead.locator('xpath=..');
  const frameStyle = await frame.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      borderTopWidth: cs.borderTopWidth,
      borderTopStyle: cs.borderTopStyle,
      borderTopColor: cs.borderTopColor,
      backdropFilter: cs.backdropFilter,
      boxShadow: cs.boxShadow,
    };
  });
  // frameSx (shellStyles.js) / phosphor.roles.js: 3px solid orange double frame.
  expect(frameStyle.borderTopWidth).toBe('3px');
  expect(frameStyle.borderTopStyle).toBe('solid');
  expect(frameStyle.borderTopColor).toBe(ORANGE);
  // Depth is border + hue + glow only — frameSx sets no `backdropFilter`.
  expect(frameStyle.backdropFilter).toBe('none');
  // Ambient panel glow (roles.shell.glow) — a real box-shadow, not 'none'.
  expect(frameStyle.boxShadow).not.toBe('none');
});

test('CRT scanline/vignette pass covers the shell as a single non-interactive fixed layer', async ({ page }) => {
  await goto(page, 'Tasks');

  // Installed once by skins/phosphor.jsx's <CssBaseline/> as `body::before`
  // (theme/components/cssBaseline.ts) — not re-applied per view/component.
  const crt = await page.evaluate(() => {
    const cs = getComputedStyle(document.body, '::before');
    return { content: cs.content, position: cs.position, pointerEvents: cs.pointerEvents, zIndex: cs.zIndex };
  });
  expect(crt.content).not.toBe('none');
  expect(crt.position).toBe('fixed');
  expect(crt.pointerEvents).toBe('none'); // never intercepts input
  expect(crt.zIndex).toBe('1'); // theme.nerv.layers.crt
});

test('sidebar and menu navigation are bilingual with English-only accessible names', async ({ page }) => {
  await goto(page, 'Tasks');

  const sidebar = page.locator('aside');
  // Tasks nav row: large Mincho '任務' (aria-hidden) paired with the English
  // caption 'Tasks' — both visible, but the accessible name stays English-only
  // (design.md: "accessible names are English only").
  await expect(sidebar.getByText('任務', { exact: true })).toBeVisible();
  // Not `exact: true` — the row also carries a live task-count Stamp sibling
  // ("Tasks 4"), which is legitimately part of the accessible name (it's real,
  // visible English/numeral content, unlike the aria-hidden jp glyph).
  const tasksBtn = sidebar.getByRole('button', { name: 'Tasks' });
  await expect(tasksBtn).toBeVisible();
  await expect(tasksBtn).toHaveAccessibleName(/^Tasks\b/);

  // New session row: '新規' / 'New session' (no count sibling, so this name is exact).
  await expect(sidebar.getByText('新規', { exact: true })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'New session', exact: true })).toHaveAccessibleName('New session');

  // Overflow menu: same bilingual grammar, e.g. Config '設定' / 'Config'.
  await openMenu(page);
  const menu = page.getByRole('menu');
  await expect(menu.getByText('設定', { exact: true })).toBeVisible();
  const configItem = page.getByRole('menuitem', { name: 'Config', exact: true });
  await expect(configItem).toBeVisible();
  await expect(configItem).toHaveAccessibleName('Config');
  await page.keyboard.press('Escape');
});

test('current nav selection uses semantic figure-ground inversion, not the ZAPAC gradient marker', async ({ page }) => {
  await goto(page, 'Tasks');

  const sidebar = page.locator('aside');
  const tasksBtn = sidebar.getByRole('button', { name: 'Tasks' });

  // `goto()` reaches Tasks by clicking this very row, which leaves the pointer
  // parked on it — reading the computed style now would measure the hover
  // state, not the resting "current" state this test is about. Park the mouse
  // in the corner first. (Both states are asserted: resting here, hover below.)
  await page.mouse.move(0, 0);
  await expect(tasksBtn).toHaveCSS('background-color', MINT);

  const style = await tasksBtn.evaluate((el) => {
    const cs = getComputedStyle(el);
    const before = getComputedStyle(el, '::before');
    return { backgroundColor: cs.backgroundColor, color: cs.color, beforeBackgroundImage: before.backgroundImage, beforeContent: before.content };
  });
  // MuiListItemButton's Phosphor override: solid mint fill, near-black content
  // — the "figure/ground inversion" the spec requires for a current/selected
  // control (never a glow on the punched-out content).
  expect(style.backgroundColor).toBe(MINT);
  expect(style.color).toBe(VOID);
  // ZAPAC's sanctioned active indicator is a `::before` left-edge gradient bar
  // (Sidebar.jsx's non-Phosphor branch, `background: brandGrad(t)`) — the
  // Phosphor branch renders no such pseudo-element at all.
  expect(style.beforeContent === 'none' || style.beforeBackgroundImage === 'none').toBe(true);

  // Hovering the current row must KEEP the inversion (peak mint), not dissolve
  // it into MUI's translucent hover overlay — regression guard for the
  // `&.Mui-selected:hover` rule in Sidebar.jsx's Phosphor branch.
  await tasksBtn.hover();
  const hovered = await tasksBtn.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(hovered).not.toMatch(/rgba/); // opaque fill, not an alpha tint
});

test('masthead and sidebar reflect live counts and connection state from real data, no fabricated telemetry', async ({ page }) => {
  await goto(page, 'Tasks');

  const masthead = page.getByRole('banner');
  // The sandbox WS connects to the sandbox daemon — real `connected` state.
  // Not `exact` and not a plain getByText: after the 8.6 review the loopback
  // address moved INSIDE this stamp, so the element now owns two text nodes
  // ("DAEMON:CONNECTED" + the host). Matching the stamp itself and asserting
  // both parts keeps this honest about the merged readout rather than
  // loosening it to a substring anywhere on the page.
  const daemonStamp = masthead.getByText(/DAEMON:CONNECTED/);
  await expect(daemonStamp).toBeVisible();
  // Real loopback address from `location.host`, not a fabricated one — the
  // sandbox serves the app on 127.0.0.1, so assert the shape rather than a
  // hardcoded port (serve.mjs picks a free one per run).
  await expect(daemonStamp).toHaveText(/DAEMON:CONNECTED\s*127\.0\.0\.1:\d+/);
  // The AGENTS n/n stat was removed in the 8.6 visual pass (it isn't in the
  // peg's masthead); its absence is asserted below alongside the other
  // non-fabricated-telemetry checks.
  await expect(masthead.getByText(/AGENTS/)).toHaveCount(0);
  // Nothing in PhosphorMasthead.jsx fabricates an aggregate health score —
  // the one-shot mockup's "SYS:NOMINAL" demo telemetry must not appear.
  await expect(page.getByText('SYS:NOMINAL')).toHaveCount(0);
  // Nor the peg's other demo-only readouts (DAEMON LOAD / EX_MODE / PRIORITY).
  await expect(page.getByText(/DAEMON LOAD|EX_MODE|PRIORITY:/)).toHaveCount(0);

  // Sidebar's DaemonFooter renders the same live `connected` flag as its own
  // domain-state-driven stamp + explicit English text (never colour-only).
  const sidebar = page.locator('aside');
  await expect(sidebar.getByText('DAEMON CONNECTED', { exact: true })).toBeVisible();
});

test('More menu is a portaled, orange-framed console menu with a red destructive action', async ({ page }) => {
  await goto(page, 'Tasks');
  await openMenu(page);

  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();

  // AppMenu.jsx's Phosphor `slotProps.paper.sx`: 2px solid orange, hard edge,
  // no radius, no backdrop blur.
  const paper = page.locator('.MuiPopover-paper').filter({ has: menu });
  const paperStyle = await paper.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { borderWidth: cs.borderTopWidth, borderColor: cs.borderTopColor, borderRadius: cs.borderTopLeftRadius, backdropFilter: cs.backdropFilter };
  });
  expect(paperStyle.borderWidth).toBe('2px');
  expect(paperStyle.borderColor).toBe(ORANGE);
  expect(paperStyle.borderRadius).toBe('0px');
  expect(paperStyle.backdropFilter).toBe('none');

  // Portaled: `Menu` renders through a MUI `Popover` portal straight to
  // `document.body`, so the frame's chamfer/clip can never cut it off — the
  // frame element (the masthead's parent, see the frame test above) must not
  // be an ancestor of the menu paper.
  const isInsideFrame = await page.evaluate(() => {
    const header = document.querySelector('header');
    const frame = header?.parentElement;
    const paperEl = document.querySelector('.MuiPopover-paper');
    return !!(frame && paperEl && frame.contains(paperEl));
  });
  expect(isInsideFrame).toBe(false);

  // The whole menu paper must render fully inside the viewport (not clipped).
  const box = await paper.boundingBox();
  const viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);

  // Destructive restart row: red, not mint/orange/idle-green — same
  // destination/action as ZAPAC's `warning.main` row, red under Phosphor
  // (`theme.vars.palette.error.main`, AA-adjusted by phosphor.jsx). Checked
  // structurally (red channel dominant, distinct from the other two chrome/
  // status hues) rather than one exact hex — see the file-header note.
  const restartItem = page.getByRole('menuitem', { name: 'Restart server', exact: true });
  await expect(restartItem).toBeVisible();
  const restartColor = await restartItem.evaluate((el) => getComputedStyle(el).color);
  expect(restartColor).not.toBe(MINT);
  expect(restartColor).not.toBe(ORANGE);
  const [r, g, b] = restartColor.match(/\d+/g).map(Number);
  expect(r).toBeGreaterThan(g); // red-dominant
  expect(r).toBeGreaterThan(b * 0.9);
  expect(r).toBeGreaterThan(150);

  await page.keyboard.press('Escape');
});

test('no ZAPAC glass identifiers appear in Phosphor chrome', async ({ page }) => {
  await goto(page, 'Tasks');

  // Sidebar: hard edge, not the ZAPAC pill/large-radius rail.
  const sidebar = page.locator('aside');
  const sidebarRadius = await sidebar.evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  expect(sidebarRadius).toBe('0px');

  // Frame: no glass blur (re-asserted narrowly here as the "absence" half of
  // the frame test above).
  const frameBackdrop = await page.getByRole('banner').locator('xpath=..').evaluate((el) => getComputedStyle(el).backdropFilter);
  expect(frameBackdrop).toBe('none');

  // The rail carries no brand tile at all under Phosphor — the peg's `.side`
  // has no logo (the `特異点 SINGULARITY` monogram lives only in the masthead),
  // so the 8.6 visual pass removed it. This subsumes the earlier, weaker check
  // that the tile merely wasn't painted with ZAPAC's purple→cyan identity
  // gradient: an element that doesn't exist can't leak it.
  await expect(sidebar.getByRole('img', { name: 'Singularity' })).toHaveCount(0);
  // ...but the identity itself is still present, in the masthead where the peg
  // puts it — so this asserts relocation, not deletion.
  await expect(page.getByRole('banner').getByText('SINGULARITY')).toBeVisible();

  // Belt-and-braces on the gradient itself: ZAPAC's `brandGrad()` literal
  // fallback (`linear-gradient(45deg,#aa41af…,#3c69c8…,#00a5e6…)`) must not
  // appear on ANY element in the Phosphor shell. This is the assertion that
  // actually caught the real leak — `brandGrad()`/`brandGlow()` fall through
  // to those hardcoded ZAPAC hexes for any skin lacking `palette.gradient.brand`.
  const zapacGradientCount = await page.evaluate(() => {
    let n = 0;
    for (const el of document.querySelectorAll('*')) {
      const bg = getComputedStyle(el).backgroundImage;
      if (/aa41af|3c69c8|00a5e6/i.test(bg)) n++;
    }
    return n;
  });
  expect(zapacGradientCount).toBe(0);
});

// ── task 8.6: fixes from the manual visual review against the peg ───────────
// Each assertion below corresponds to a specific finding, so a regression names
// the finding it undid rather than just "layout changed".

test('masthead matches the peg: seven-segment clock, AUG 06 2026 dateline, no orphaned chrome', async ({ page }) => {
  await goto(page, 'Tasks');
  const masthead = page.getByRole('banner');

  // The peg's `.timechip` is a seven-segment SVG readout, not text digits —
  // six digits, each an <svg> of lit/unlit polygons (the previous DigitalClock
  // rendered plain characters and had none).
  const clock = masthead.getByRole('img', { name: 'Local time' });
  await expect(clock).toBeVisible();
  await expect(clock.locator('svg')).toHaveCount(6);

  // Dateline: `MMM DD YYYY`, e.g. AUG 06 2026 (peg's own MONTHS + pad2 recipe).
  await expect(masthead.getByText(/^[A-Z]{3} \d{2} \d{4}$/)).toBeVisible();

  // `COMMAND CONSOLE` was removed. Its Japanese half must have gone with it —
  // a bare 統制卓 would violate the never-orphan-a-bilingual-pair rule.
  await expect(page.getByText('COMMAND CONSOLE')).toHaveCount(0);
  await expect(page.getByText('統制卓')).toHaveCount(0);
});

test('sidebar matches the peg: no nav icons, and More sits below the last nav item', async ({ page }) => {
  await goto(page, 'Tasks');
  const sidebar = page.locator('aside');

  // In this theme the kanji IS the icon — the peg's nav buttons are jp+en+count
  // with no icon glyph, so the expanded rows carry no MUI SvgIcon.
  for (const name of ['Tasks', 'Automation', 'Usage']) {
    await expect(sidebar.getByRole('button', { name }).locator('svg')).toHaveCount(0);
  }

  // `.nav-more` is the final child of the nav in the peg, not a header-row
  // button. Assert by geometry — it must sit BELOW the last nav item — which is
  // what "move the 3 dots to another button below the last item" actually means.
  const more = sidebar.getByRole('button', { name: 'More', exact: true });
  await expect(more).toBeVisible();
  const usageBox = await sidebar.getByRole('button', { name: 'Usage' }).boundingBox();
  const moreBox = await more.boundingBox();
  expect(moreBox.y).toBeGreaterThan(usageBox.y);

  // It must still open the menu — position moved, behaviour did not.
  await more.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
});
