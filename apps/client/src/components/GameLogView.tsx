/**
 * Game-log view (fh-y2a.2): the finished game hand by hand — who dealt, the
 * auction in call order, each trick's leader and winner, and the running
 * totals after the hand. Rendered from the server-built summary the gameLog
 * event delivers at game end (and re-delivers on reconnect), so the story
 * survives a reload straight into gameOver.
 */

import type { ReactNode } from 'react';
import { bidName, type Bid } from '@five-hundred/engine';
import type { GameLogHand } from '@five-hundred/protocol';

/** A call as prose: numeric bids via bidName, the named bids in words. */
export function callName(bid: Bid): string {
  if (bid.kind === 'PASS') return 'Pass';
  if (bid.kind === 'NULLA') return 'Nulla';
  if (bid.kind === 'DNULLA') return 'Double nulla';
  return bidName(bid);
}

export interface GameLogViewProps {
  hands: readonly GameLogHand[];
  /** Seat-indexed display names (see seatName). */
  names: readonly string[];
  /** The viewer's side (seat % 2) for Us/Them orientation. */
  us: number;
}

export function GameLogView(props: GameLogViewProps): ReactNode {
  const { hands, names, us } = props;
  return (
    <section className="game-log" data-testid="game-log">
      <ol className="game-log-hands">
        {hands.map((hand) => (
          <li key={hand.handNumber} className="game-log-hand" data-testid="game-log-hand">
            <h3 data-testid="game-log-dealer">
              Hand {hand.handNumber + 1} — dealt by {names[hand.dealer]}
            </h3>
            {hand.redeals > 0 && (
              <p className="game-log-redeals" data-testid="game-log-redeals">
                {hand.redeals === 1
                  ? 'Thrown in once before this deal — every seat passed.'
                  : `Thrown in ${hand.redeals} times before this deal — every seat passed.`}
              </p>
            )}
            <p className="game-log-auction" data-testid="game-log-auction">
              {hand.auction.map((c) => `${names[c.seat]}: ${callName(c.bid)}`).join(', ')}
            </p>
            <ol className="game-log-tricks">
              {hand.tricks.map((trick, i) => (
                <li key={i} data-testid="game-log-trick">
                  Trick {i + 1}: {names[trick.leader]} led, {names[trick.winner]} won
                </li>
              ))}
            </ol>
            <p className="game-log-scores" data-testid="game-log-scores">
              After: Us {hand.scores[us]} – Them {hand.scores[1 - us]}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
