/**
 * Trick-inspection helpers shared by bot policies: who holds the trick so
 * far and how strong their card is, via the engine's cardPower. Pure
 * current-trick comparisons only — no memory of unseen cards, so they stay
 * cheap enough for Hard-bot rollouts.
 */

import type { Card, TrickPlay } from '@five-hundred/engine';
import { cardPower } from '@five-hundred/engine';

/** The play currently winning the trick, or null before any card is played. */
export function bestPlaySoFar(
  plays: readonly TrickPlay[],
  trump: number | null,
  ledSuit: number | null,
): TrickPlay | null {
  let best: TrickPlay | null = null;
  let bestPower = -1;
  for (const p of plays) {
    const power = cardPower(p.card, trump, ledSuit);
    if (power > bestPower) {
      best = p;
      bestPower = power;
    }
  }
  return best;
}

/** Power of the card currently winning the trick; -1 before any play. */
export function bestPowerSoFar(
  plays: readonly TrickPlay[],
  trump: number | null,
  ledSuit: number | null,
): number {
  const best = bestPlaySoFar(plays, trump, ledSuit);
  return best === null ? -1 : cardPower(best.card, trump, ledSuit);
}

/** Legal cards that would not take the trick as it currently stands. */
export function losingPlays(
  legal: readonly Card[],
  plays: readonly TrickPlay[],
  trump: number | null,
  ledSuit: number | null,
): Card[] {
  const best = bestPowerSoFar(plays, trump, ledSuit);
  return legal.filter((c) => cardPower(c, trump, ledSuit) < best);
}
