/**
 * Which trick the debug panel's "flag this trick" button pins (fh-q2m).
 *
 * The human always means "the trick I am looking at", which is not always the
 * one the engine is about to fill: while cards are going down it is the trick
 * in progress (index `tricksPlayed`), but in the beat after a trick resolves —
 * and all through handScored — the felt still shows the trick that just ended,
 * one index back. Before a card has been played there is nothing to flag.
 */

import type { RedactedView, TrickPlay } from '@five-hundred/engine';

export interface FlagTarget {
  /** The view's hand number, matching HandRecord.handNumber in the corpus. */
  readonly hand: number;
  /** 0-based index into that hand's tricks. */
  readonly trick: number;
  /**
   * Last card down in that trick, if any (fh-g4g). Display only — the server
   * stamps the authoritative copy onto the marker from its own state — but it
   * is what puts the 0-based engine seat in front of the human writing the
   * note, who otherwise only ever sees the UI's 1-based "Bot N".
   */
  readonly play?: TrickPlay;
}

/** Last card played to a trick, or undefined for a trick with none yet. */
function lastPlay(plays: readonly TrickPlay[] | undefined): TrickPlay | undefined {
  return plays === undefined || plays.length === 0 ? undefined : plays[plays.length - 1];
}

export function flagTarget(view: RedactedView): FlagTarget | null {
  if (view.trick !== null) {
    const play = lastPlay(view.trick.plays);
    return {
      hand: view.handNumber,
      trick: view.tricksPlayed,
      ...(play === undefined ? {} : { play }),
    };
  }
  if (view.tricksPlayed > 0) {
    const play = lastPlay(view.lastTrick?.plays);
    return {
      hand: view.handNumber,
      trick: view.tricksPlayed - 1,
      ...(play === undefined ? {} : { play }),
    };
  }
  return null;
}
