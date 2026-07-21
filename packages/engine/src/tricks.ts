/**
 * Card power / follow logic.
 *
 * Ports effective_suit, card_power, and legal_plays from the Python oracle
 * (five_hundred.py lines 142-186) with identical numeric power constants:
 * joker 3000, right bower 2999, left bower 2998, trump 2000+rank,
 * led suit 1000+rank, everything else 0. `trump = null` covers NT, nulla,
 * and double nulla (mirrors trump_of).
 */

import { type Card, JOKER, SAME_COLOR, cardRank, cardSuit } from './cards.js';

/**
 * The suit a card counts as for following purposes.
 *
 * - Trump hands: joker and left bower are trump.
 * - No-trump-type hands (NT, nulla, dnulla): the joker is every suit, so it
 *   counts as whatever suit was led.
 */
export function effectiveSuit(
  card: Card,
  trump: number | null,
  ledSuit: number | null,
): number | null {
  if (card === JOKER) {
    return trump !== null ? trump : ledSuit;
  }
  const s = cardSuit(card) as number;
  const r = cardRank(card) as number;
  if (trump !== null && r === 11 && s === SAME_COLOR[trump]) {
    return trump; // left bower belongs to the trump suit
  }
  return s;
}

/** Sortable strength of a card within a trick. Higher wins. */
export function cardPower(card: Card, trump: number | null, ledSuit: number | null): number {
  if (card === JOKER) {
    return 3000; // highest card, takes any trick
  }
  const s = cardSuit(card) as number;
  const r = cardRank(card) as number;
  if (trump !== null) {
    if (r === 11 && s === trump) return 2999; // right bower
    if (r === 11 && s === SAME_COLOR[trump]) return 2998; // left bower
    if (s === trump) return 2000 + r;
  }
  if (s === ledSuit) return 1000 + r;
  return 0;
}

/**
 * Legal cards given the effective led suit (null = leading the trick).
 *
 * The joker-blocks-sluffing rule falls out naturally: in NT/nulla hands the
 * joker's effective suit is always the led suit, so while you hold it you
 * can always follow — and if it is your only follower, you must play it.
 */
export function legalPlays(
  hand: readonly Card[],
  trump: number | null,
  ledSuit: number | null,
): Card[] {
  const cards = [...hand];
  if (ledSuit === null) {
    return cards;
  }
  const followers = cards.filter((c) => effectiveSuit(c, trump, ledSuit) === ledSuit);
  return followers.length > 0 ? followers : cards;
}
