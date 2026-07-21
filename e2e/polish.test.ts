/**
 * M8 polish probe (PRD 6.3): the smoke flow again, but on a 375px phone
 * viewport, asserting the layout never grows a horizontal scrollbar on any
 * screen — home, lobby, auction (bid grid), play, and the hand-end overlay —
 * and that the manual theme toggle pins a scheme that survives a reload.
 * Widths 768/1280 ride along on the home/lobby screens; the deeper game
 * screens reuse the deterministic seeded hand at 375 only, where overflow
 * risk is real.
 */

import { expect, test, type Page } from '@playwright/test';

const POLL_MS = 50;

test.use({ viewport: { width: 375, height: 667 } });

/** True when the page needs no horizontal scroll at its current width. */
async function fitsViewport(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
}

async function expectNoHorizontalScroll(page: Page, screen: string): Promise<void> {
  expect(await fitsViewport(page), `horizontal overflow on ${screen}`).toBe(true);
}

test('phone width: every screen fits 375px and the theme toggle persists', async ({ page }) => {
  // Home — and the theme toggle round-trip while the screen is quiet.
  await page.goto('/');
  await expectNoHorizontalScroll(page, 'home');
  const startScheme = await page.evaluate(() => document.documentElement.dataset.theme ?? 'system');
  expect(startScheme).toBe('system'); // untouched: no pin, OS preference rules
  await page.getByTestId('theme-toggle').click();
  const pinned = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(pinned === 'light' || pinned === 'dark').toBe(true);
  await page.reload();
  await expect(page.getByTestId('name-input')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(pinned);

  // Wider breakpoints on the pre-game screens.
  for (const width of [768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expectNoHorizontalScroll(page, `home@${width}`);
  }
  await page.setViewportSize({ width: 375, height: 667 });

  await page.getByTestId('name-input').fill('Phone');
  await page.getByTestId('create-room').click();

  // Lobby.
  await expect(page.getByTestId('room-code')).toBeVisible();
  await expectNoHorizontalScroll(page, 'lobby');
  for (const seat of [1, 2, 3]) {
    await page.getByTestId(`difficulty-${seat}`).selectOption('easy');
  }
  await page.getByTestId('start-game').click();

  // Auction: the full bid grid must fit and stay tappable — proven by
  // actually tapping Pass at this width until the auction closes.
  const bidPanel = page.getByTestId('bid-panel');
  const passButton = page.getByRole('button', { name: 'Pass', exact: true });
  await expect(bidPanel).toBeVisible();
  await expectNoHorizontalScroll(page, 'auction');
  await expect(passButton).toBeEnabled();
  while (await bidPanel.isVisible()) {
    await passButton.click({ timeout: 500 }).catch(() => {});
    await page.waitForTimeout(POLL_MS);
  }

  // Play through to the overlay, checking width as the trick area fills.
  // A playable card mid-fan exposes only its left sliver at the phone
  // overlap; a finger taps the sliver, but Playwright's center-point click
  // lands on the covering neighbor, so the click is dispatched directly —
  // hit-tested tapping is the desktop smoke test's job, layout is ours.
  const overlay = page.getByTestId('hand-end-overlay');
  while (!(await overlay.isVisible())) {
    await expectNoHorizontalScroll(page, 'table');
    const card = page.locator('.hand-card-playable').last();
    await card.dispatchEvent('click', {}, { timeout: 500 }).catch(() => {});
    await page.waitForTimeout(POLL_MS);
  }
  await expectNoHorizontalScroll(page, 'hand-end overlay');
});
