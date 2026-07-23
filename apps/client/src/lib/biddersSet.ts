/**
 * "The bidders are set" predicate (fh-d2d): the single source of truth for
 * whether the declaring side has already failed its contract, shared by the
 * felt (TrickArea, via Table) and the HUD so the two never disagree.
 *
 * A set is often mathematically certain well before the last trick, and the
 * UI says so the instant it is:
 *   - numbered contract: the bidders end with at most (10 - defenderTricks)
 *     tricks, so they are set once that ceiling drops below the bid level;
 *   - slam: the contract is all 10, so any defender trick sets it;
 *   - nulla / double nulla: the goal is zero, so one forced trick sets it.
 * At hand end the engine's HandResult.made confirms it (and covers the rare
 * make that only fails on the final trick, which is never certain early).
 * Everything the predicate needs is already on the redacted view, so no new
 * server data is involved; a fresh deal clears contract/declarer/handResult,
 * which clears the state.
 */

import { type Bid, type HandResult, isLoseAll } from '@five-hundred/engine';

/** The slice of RedactedView the predicate reads. */
export interface SetStateView {
  readonly contract: Bid | null;
  readonly declarer: number | null;
  readonly slam: boolean;
  readonly sideTricks: readonly [number, number];
  readonly handResult: HandResult | null;
}

/** Total tricks in a hand — the ceiling the bidders' count is measured against. */
const TRICKS_PER_HAND = 10;

/** True once the declaring side can no longer make the contract. */
export function biddersAreSet(view: SetStateView): boolean {
  const contract = view.contract;
  if (contract === null || view.declarer === null) return false;
  // Hand end: the engine has scored it, so no inference is needed.
  if (view.handResult !== null) return !view.handResult.made;
  const declSide = view.declarer % 2;
  const bidderTricks = view.sideTricks[declSide] ?? 0;
  const defenderTricks = view.sideTricks[1 - declSide] ?? 0;
  // Lose-all: the bidders must take none, so the first forced trick is fatal.
  if (isLoseAll(contract)) return bidderTricks >= 1;
  // A declared slam plays for all 10 whatever the bid level was.
  const target = view.slam ? TRICKS_PER_HAND : contract.level;
  return TRICKS_PER_HAND - defenderTricks < target;
}
