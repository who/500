/**
 * Shared "is this card trump?" test for the foil marking on card faces
 * (fh-wye). Both surfaces that show faces — the viewer's own hand and the
 * trick in the middle — ask this so a card shimmers identically wherever it
 * sits.
 *
 * Trump membership is exactly the engine's effectiveSuit with no led suit,
 * which folds in the left bower (the same-color jack) and the joker, which
 * is trump in any trump contract. NT/nulla/double-nulla have no trump, so
 * nothing is marked.
 */

import { type Card, effectiveSuit } from '@five-hundred/engine';

/** True when `card` counts as trump under `trump` (null = NT/nulla: never). */
export function isTrumpCard(card: Card, trump: number | null): boolean {
  if (trump === null) return false;
  return effectiveSuit(card, trump, null) === trump;
}

/** The face class marking a trump card, or undefined when it is not trump. */
export function trumpFaceClass(card: Card, trump: number | null): string | undefined {
  return isTrumpCard(card, trump) ? 'card-trump' : undefined;
}
