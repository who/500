/**
 * Upward-scaling matrix (fh-mwj / AC-1, AC-3): the game must grow with the
 * viewport instead of sitting in a fixed 900px column. The seeded auction
 * (Bot 2 wins at 7S) makes trick 1 freeze on the human's turn with three
 * bot cards on the felt — a stable, deterministic layout to measure. The
 * viewport then steps through 1280/1920/2560 over that same frozen state:
 * table column, hand cards, and trick area must all grow monotonically, the
 * fan overlap must keep its proportion (overlap derives from the same --su
 * scale unit as the card width), and every trick card must stay inside the
 * trick felt (placement geometry derives from the scale too, so the cards
 * cannot drift off the felt as it grows).
 */

import { expect, test, type Page } from '@playwright/test';

const POLL_MS = 50;

/** Widths from the acceptance criteria; heights tall enough to stay out of
 *  the short-landscape media query. */
const WIDTHS = [1280, 1920, 2560];

interface Snapshot {
  rootFontPx: number;
  tableWidth: number;
  trick: { left: number; top: number; right: number; bottom: number; width: number };
  cardWidth: number;
  /** offsetLeft delta between adjacent hand cards (layout-space, so the fan
   *  rotation transforms can't skew it). */
  cardStep: number;
  trickCards: { left: number; top: number; right: number; bottom: number }[];
}

function measure(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width };
    };
    const table = document.querySelector('.table-screen') as HTMLElement;
    const trickArea = document.querySelector('.trick-area') as HTMLElement;
    const cards = [...document.querySelectorAll('.my-hand .hand-card')] as HTMLElement[];
    return {
      rootFontPx: parseFloat(getComputedStyle(document.documentElement).fontSize),
      tableWidth: table.getBoundingClientRect().width,
      trick: rect(trickArea),
      cardWidth: cards[0]!.offsetWidth,
      cardStep: cards[1]!.offsetLeft - cards[0]!.offsetLeft,
      trickCards: [...document.querySelectorAll('.trick-area .trick-card')].map(rect),
    };
  });
}

test('the table, cards, and trick area scale up across 1280/1920/2560', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });

  // Reach the frozen mid-trick state: create, start (the three open seats
  // become Hard bots), pass the auction away, and wait for trick 1 to stall
  // on the human.
  await page.goto('/');
  await page.getByTestId('name-input').fill('Scale');
  await page.getByTestId('create-room').click();
  await expect(page.getByTestId('room-code')).toBeVisible();
  await page.getByTestId('start-game').click();

  const bidPanel = page.getByTestId('bid-panel');
  const passButton = page.getByRole('button', { name: 'Pass', exact: true });
  await expect(bidPanel).toBeVisible();
  while (await bidPanel.isVisible()) {
    await passButton.click({ timeout: 500 }).catch(() => {});
    await page.waitForTimeout(POLL_MS);
  }

  // The pinned seed: seat 1 declares and leads, so the human plays last to
  // trick 1 —
  // three bot cards sit on the felt while the game waits for us.
  await expect(page.locator('.trick-area .trick-card')).toHaveCount(3);
  await expect(page.locator('.hand-card-playable').first()).toBeVisible();
  // Zero bot pacing lands all three cards near-simultaneously; let their
  // 160ms fly-in animations finish so positions are at rest when measured.
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.trick-card')].every((el) => el.getAnimations().length === 0),
  );

  const snapshots: Snapshot[] = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 1000 });
    snapshots.push(await measure(page));
    await page.screenshot({ path: testInfo.outputPath(`scale-${width}.png`) });
  }

  for (const [i, snap] of snapshots.entries()) {
    const label = `@${WIDTHS[i]}`;

    // AC-3: all three trick cards sit inside the felt at every width.
    expect(snap.trickCards, label).toHaveLength(3);
    for (const c of snap.trickCards) {
      expect(c.left, label).toBeGreaterThanOrEqual(snap.trick.left - 2);
      expect(c.right, label).toBeLessThanOrEqual(snap.trick.right + 2);
      expect(c.top, label).toBeGreaterThanOrEqual(snap.trick.top - 2);
      expect(c.bottom, label).toBeLessThanOrEqual(snap.trick.bottom + 2);
    }

    // AC-1: the fan overlap keeps its base proportion (30/64 of a card).
    expect(snap.cardStep / snap.cardWidth, label).toBeGreaterThan(30 / 64 - 0.02);
    expect(snap.cardStep / snap.cardWidth, label).toBeLessThan(30 / 64 + 0.02);

    // AC-1: everything grew from the previous width.
    if (i > 0) {
      const prev = snapshots[i - 1]!;
      expect(snap.tableWidth, label).toBeGreaterThan(prev.tableWidth);
      expect(snap.cardWidth, label).toBeGreaterThan(prev.cardWidth);
      expect(snap.trick.width, label).toBeGreaterThan(prev.trick.width);
      expect(snap.rootFontPx, label).toBeGreaterThan(prev.rootFontPx);
    }
  }

  // The old ceilings are gone: past 900px column at 1280, and cards clearly
  // larger than the 64px base by 2560 (but capped short of comic size).
  expect(snapshots[0]!.tableWidth).toBeGreaterThan(950);
  expect(snapshots[2]!.cardWidth).toBeGreaterThan(90);
  expect(snapshots[2]!.cardWidth).toBeLessThan(110);
});
