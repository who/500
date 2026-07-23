/**
 * Which trick the debug panel's "flag this trick" button pins (fh-q2m).
 *
 * The human always means "the trick I am looking at", which is not always the
 * one the engine is about to fill: while cards are going down it is the trick
 * in progress (index `tricksPlayed`), but in the beat after a trick resolves —
 * and all through handScored — the felt still shows the trick that just ended,
 * one index back. Before a card has been played there is nothing to flag.
 */

import type { RedactedView } from '@five-hundred/engine';

export interface FlagTarget {
  /** The view's hand number, matching HandRecord.handNumber in the corpus. */
  readonly hand: number;
  /** 0-based index into that hand's tricks. */
  readonly trick: number;
}

export function flagTarget(view: RedactedView): FlagTarget | null {
  if (view.trick !== null) return { hand: view.handNumber, trick: view.tricksPlayed };
  if (view.tricksPlayed > 0) return { hand: view.handNumber, trick: view.tricksPlayed - 1 };
  return null;
}
