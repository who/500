/**
 * Dealing — port of deal (five_hundred.py lines 513-518).
 */

import type { Card } from './cards.js';
import { DECK } from './cards.js';
import type { Rng } from './rng.js';

export interface Deal {
  /** Four sorted 10-card hands, indexed by seat. */
  hands: Card[][];
  /** The 5-card middle (kitty), in shuffle order. */
  middle: Card[];
}

export function deal(rng: Rng): Deal {
  const cards = [...DECK];
  rng.shuffle(cards);
  const hands = Array.from({ length: 4 }, (_, i) =>
    cards.slice(i * 10, (i + 1) * 10).sort((a, b) => a - b),
  );
  const middle = cards.slice(40);
  return { hands, middle };
}
