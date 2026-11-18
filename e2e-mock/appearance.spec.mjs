// Appearance settings spec: colour mode toggle, skin switch to the dark-only
// Phosphor console with persistence across reload, and the switch back.
import { test, expect } from './fixtures/test.mjs';
import { gotoUrl } from '../e2e/helpers/nav.mjs';

test('colour mode, Phosphor skin persisted across reload, and back to ZAPAC', async ({ page }) => {
  await gotoUrl(page, 'Appearance');

  // Colour mode first: Phosphor is dark-only. MUI's ToggleButtonGroup sets
  // aria-pressed on the selected button.
  const lightBtn = page.getByRole('button', { name: 'Light mode' });
  const darkBtn = page.getByRole('button', { name: 'Dark mode' });
  await lightBtn.click();
  await expect(lightBtn).toHaveAttribute('aria-pressed', 'true');
  await darkBtn.click();
  await expect(darkBtn).toHaveAttribute('aria-pressed', 'true');

  // Shell remounts on skin change — toHaveAttribute retries until the new
  // instance of this radio (found fresh each poll) reports checked.
  const phosphor = page.getByRole('radio').filter({ hasText: 'Phosphor Console' });
  await phosphor.click();
  await expect(phosphor).toHaveAttribute('aria-checked', 'true');

  // Phosphor is dark-only (`PHOSPHOR_META.supportsColorMode: false`) — no
  // Light/Dark toggle is offered, only the "is dark-only" caption.
  await expect(page.getByRole('button', { name: 'Light mode' })).not.toBeVisible();
  await expect(page.getByText('Phosphor Console is dark-only.')).toBeVisible();

  // Reload: the skin is persisted under 'sing-skin' and the view is URL-owned,
  // so the shell lands back on Appearance still showing the Phosphor console.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  await expect(phosphor).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Phosphor Console is dark-only.')).toBeVisible();

  // Back to ZAPAC: the caption goes and the light/dark toggle works again.
  const zapac = page.getByRole('radio').filter({ hasText: 'ZAPAC' });
  await zapac.click();
  await expect(zapac).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Phosphor Console is dark-only.')).not.toBeVisible();
  await lightBtn.click();
  await expect(lightBtn).toHaveAttribute('aria-pressed', 'true');
});
