/**
 * Per-card play legality and reason text (PRD section 6.1: illegal cards are
 * dimmed with a reason on hover/long-press).
 *
 * Legality itself is never recomputed client-side: the legal set is exactly
 * the playCard actions the server sent in the actionRequest. Only the
 * human-readable reason for an illegal card is derived locally, from view
 * data the seat already knows (led suit + own hand) via the engine's pure
 * effectiveSuit — display logic per PRD section 2.
 */

import {
  type Action,
  type Card,
  type RedactedView,
  JOKER,
  cardSuit,
  effectiveSuit,
  trumpOf,
} from '@five-hundred/engine';
import { SUIT_GLYPHS } from '../components/Card.tsx';

const SUIT_NOUNS = ['spades', 'clubs', 'diamonds', 'hearts'] as const;

/** Fallback when no specific explanation applies (see plan-gap guidance). */
export const GENERIC_REASON = 'Not legal right now.';

/**
 * The joker-blocks-sluffing house rule (PRD 6.2, rules doc joker section):
 * in NT/nulla hands the joker follows every suit, so a hand otherwise void
 * in the led suit still may not sluff while the joker is in it.
 */
export const JOKER_SLUFF_REASON = 'You cannot sluff while holding the joker.';

export interface PlayLegality {
  /** True when the viewer holds the play turn and the hand is interactive. */
  readonly active: boolean;
  /** Cards a tap may play directly right now (empty when not active). */
  readonly legal: ReadonlySet<Card>;
  /**
   * Cards playable only with a named suit — the joker led under no trump,
   * where the server expands it into four jokerSuit action variants. A tap
   * opens the suit picker instead of submitting immediately.
   */
  readonly needsSuit: ReadonlySet<Card>;
  /** Reason text for every held card outside the playable sets. */
  readonly reasons: ReadonlyMap<Card, string>;
}

const INERT: PlayLegality = {
  active: false,
  legal: new Set(),
  needsSuit: new Set(),
  reasons: new Map(),
};

/**
 * Fold the server's actionRequest into per-card legality for the viewer's
 * hand. `actions` is the latest actionRequest payload for this seat (null or
 * empty when someone else holds the turn).
 */
export function playLegality(view: RedactedView, actions: readonly Action[] | null): PlayLegality {
  if (view.phase !== 'play' || view.toAct !== view.seat) return INERT;
  const plays: Extract<Action, { type: 'playCard' }>[] = [];
  for (const action of actions ?? []) {
    if (action.type === 'playCard' && action.seat === view.seat) plays.push(action);
  }
  if (plays.length === 0) return INERT;

  const legal = new Set<Card>();
  const needsSuit = new Set<Card>();
  for (const play of plays) {
    if (play.jokerSuit === undefined) legal.add(play.card);
    else needsSuit.add(play.card);
  }
  for (const card of legal) needsSuit.delete(card);

  const trump = view.contract === null ? null : trumpOf(view.contract);
  const ledSuit = view.trick?.ledSuit ?? null;
  // Sluff blocked by the joker: no trump, a suit led, no natural follower —
  // only the joker (every suit while held) keeps this hand following.
  const jokerBlocksSluff =
    trump === null &&
    ledSuit !== null &&
    view.hand.includes(JOKER) &&
    !view.hand.some((c) => c !== JOKER && cardSuit(c) === ledSuit);
  const reasons = new Map<Card, string>();
  for (const card of view.hand) {
    if (legal.has(card) || needsSuit.has(card)) continue;
    if (jokerBlocksSluff) {
      reasons.set(card, JOKER_SLUFF_REASON);
    } else if (ledSuit !== null && effectiveSuit(card, trump, ledSuit) !== ledSuit) {
      reasons.set(card, `You must follow ${SUIT_NOUNS[ledSuit]} (${SUIT_GLYPHS[ledSuit]}).`);
    } else {
      reasons.set(card, GENERIC_REASON);
    }
  }
  return { active: true, legal, needsSuit, reasons };
}
