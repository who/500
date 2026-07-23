/**
 * Smoke E2E (PRD 7.5): one human plus three Hard bots through a real browser
 * — create room, claim a seat, start, pass through the auction, play legal
 * cards until the hand-end overlay — with the whole stack live: built
 * client, HTTP static serving, WS transport, room lifecycle, authoritative
 * game loop, bot driver, and the Hard worker pool the bot seats decide in
 * (fh-gpk: the lobby has no difficulty choice; every bot seat is Hard).
 *
 * The script stays rules-agnostic on purpose: it always passes in the
 * auction and always clicks the first enabled card in hand, so the server's
 * legality (surfaced as enabled/dimmed UI) does all the thinking. The
 * pinned TEST_SEED (e2e/seed.ts) makes the run deterministic: the bots'
 * seeded decision streams produce EXPECTED_CONTRACT, asserted below so
 * seed drift fails loudly instead of flaking.
 */

import { expect, test, type Page } from '@playwright/test';
import { EXPECTED_CONTRACT } from './seed.ts';

/** Poll interval while waiting for the turn to come around. */
const POLL_MS = 50;

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    errors.push(String(err));
  });
  return errors;
}

test('a full hand: create room, start with 3 Hard bots, pass, play to the overlay', async ({
  page,
}) => {
  const consoleErrors = collectConsoleErrors(page);

  // Home: name yourself and create a room (the creator auto-claims seat 0).
  await page.goto('/');
  await page.getByTestId('name-input').fill('Smoke');
  await page.getByTestId('create-room').click();

  // Lobby: room code up, three open seats, no tier chip (fh-ehj) and no tier
  // to choose (fh-gpk) — then start, which fills them with named AI players.
  await expect(page.getByTestId('room-code')).toBeVisible();
  for (const seat of [1, 2, 3]) {
    await expect(page.locator(`[data-seat="${seat}"]`)).toContainText('Open seat');
    await expect(page.getByTestId(`bot-tier-${seat}`)).toHaveCount(0);
    await expect(page.getByTestId(`difficulty-${seat}`)).toHaveCount(0);
  }
  await page.getByTestId('start-game').click();
  // fh-1ni: on the felt every bot seat reads "AI <name>", all three distinct.
  const botNames = await Promise.all(
    [1, 2, 3].map((seat) =>
      page.locator(`.table-seat[data-seat="${seat}"] .seat-name strong`).innerText(),
    ),
  );
  for (const name of botNames) expect(name).toMatch(/^AI \w+$/);
  expect(new Set(botNames).size).toBe(3);

  // Auction: seat 0 opens (dealer is seat 3), so the panel must appear with
  // the human holding the turn. Pass whenever offered until a bot's winning
  // bid closes the auction and the panel unmounts.
  const bidPanel = page.getByTestId('bid-panel');
  const passButton = page.getByRole('button', { name: 'Pass', exact: true });
  await expect(bidPanel).toBeVisible();
  await expect(passButton).toBeEnabled();
  while (await bidPanel.isVisible()) {
    await passButton.click({ timeout: 500 }).catch(() => {
      // Not our turn (or the auction just ended); poll again.
    });
    await page.waitForTimeout(POLL_MS);
  }

  // Exchange runs bot-side (the seeded declarer is a bot); then play: click
  // the first enabled card whenever the turn is ours until the hand ends.
  const overlay = page.getByTestId('hand-end-overlay');
  while (!(await overlay.isVisible())) {
    const card = page.locator('.hand-card-playable').first();
    await card.click({ timeout: 500 }).catch(() => {
      // No playable card right now (bots acting, or trick resolving); poll.
    });
    await page.waitForTimeout(POLL_MS);
  }

  // Hand-end overlay: a scored result for the seeded contract. The exact
  // contract is pinned to TEST_SEED — a mismatch means the decision stream
  // drifted and e2e/pick-seed.ts should be rerun (see e2e/seed.ts). It is
  // also the proof that the bot seats really decided in the Hard worker
  // pool: this seed's Medium fallback stream bids 7H from seat 2 instead.
  await expect(page.getByTestId('hand-end-headline')).toHaveText(/(made|set|failed): [+-]\d+/);
  await expect(page.getByTestId('hand-end-contract')).toContainText(EXPECTED_CONTRACT);
  await expect(page.getByTestId('hand-end-ready-button')).toBeEnabled();

  expect(consoleErrors).toEqual([]);
});
