/**
 * Pure display ordering for a hand of cards (PRD section 6.1 screen 3).
 *
 * Suits are laid out left to right alternating colors. Once a contract
 * names a trump, the trump group comes first and absorbs the left bower
 * (via the engine's effectiveSuit), ordered right bower, left bower, then
 * rank descending. The joker always renders rightmost as its own distinct
 * card — in NT/nulla there is no trump group for it to join, and in trump
 * contracts keeping it apart matches the PRD's "joker distinct".
 */

import {
  type Bid,
  type Card,
  JOKER,
  SAME_COLOR,
  cardPower,
  effectiveSuit,
  trumpOf,
} from '@five-hundred/engine';

/**
 * Left-to-right suit layout: trump first, then the rest alternating colors
 * (the trump's color-mate goes in the middle so no two red or two black
 * suits sit adjacent). With no trump: S D C H, also alternating.
 */
export function suitDisplayOrder(trump: number | null): number[] {
  if (trump === null) return [0, 2, 1, 3];
  const mate = SAME_COLOR[trump] as number;
  const off = [0, 1, 2, 3].filter((s) => s !== trump && s !== mate);
  return [trump, off[0] as number, mate, off[1] as number];
}

/** The suit group a card renders under (left bower → trump), null = joker. */
export function displaySuit(card: Card, trump: number | null): number | null {
  if (card === JOKER) return null;
  return effectiveSuit(card, trump, null);
}

/**
 * Sort a hand for display under the given contract (null = no contract
 * yet, e.g. during the auction). Within each suit group cards run
 * strongest-first, so in the trump group the right bower leads and the
 * left bower sits second, above the ace (cardPower with the group as the
 * led suit gives exactly that ordering).
 */
export function sortHand(hand: readonly Card[], contract: Bid | null): Card[] {
  const trump = contract === null ? null : trumpOf(contract);
  const groups = new Map<number, Card[]>();
  let hasJoker = false;
  for (const card of hand) {
    if (card === JOKER) {
      hasJoker = true;
      continue;
    }
    const suit = displaySuit(card, trump) as number;
    const group = groups.get(suit);
    if (group === undefined) groups.set(suit, [card]);
    else group.push(card);
  }
  const out: Card[] = [];
  for (const suit of suitDisplayOrder(trump)) {
    const group = groups.get(suit) ?? [];
    group.sort((a, b) => cardPower(b, trump, suit) - cardPower(a, trump, suit));
    out.push(...group);
  }
  if (hasJoker) out.push(JOKER);
  return out;
}
