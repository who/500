/**
 * Game-log view (fh-y2a.2): the finished game hand by hand — who dealt, the
 * auction in call order, each trick's cards as they fell (fh-0au), and the
 * running totals after the hand. Rendered from the server-built summary the
 * gameLog event delivers at game end (and re-delivers on reconnect), so the
 * story survives a reload straight into gameOver.
 *
 * Trick rows are graphic in the Last Trick peek's visual language — compact
 * seat-labelled faces in play order, the leader chipped and the winner ringed
 * via data-winner — sized so a 10-trick hand scans as a column. The old
 * "X led, Y won" prose stays as visually hidden text for assistive tech.
 */

import type { ReactNode } from 'react';
import { bidName, type Bid } from '@five-hundred/engine';
import type { GameLogHand } from '@five-hundred/protocol';
import { CardFace } from './Card.tsx';
import { PlayerName } from './PlayerName.tsx';

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
              Hand {hand.handNumber + 1} — dealt by{' '}
              {/* `us` is a side index; PlayerName only reads its parity. */}
              <PlayerName seat={hand.dealer} viewerSeat={us} names={names} />
            </h3>
            {hand.redeals > 0 && (
              <p className="game-log-redeals" data-testid="game-log-redeals">
                {hand.redeals === 1
                  ? 'Thrown in once before this deal — every seat passed.'
                  : `Thrown in ${hand.redeals} times before this deal — every seat passed.`}
              </p>
            )}
            <p className="game-log-auction" data-testid="game-log-auction">
              {hand.auction.map((c, i) => (
                <span key={i}>
                  {i > 0 && ', '}
                  <PlayerName seat={c.seat} viewerSeat={us} names={names} />
                  {`: ${callName(c.bid)}`}
                </span>
              ))}
            </p>
            <ol className="game-log-tricks">
              {hand.tricks.map((trick, i) => (
                <li key={i} className="game-log-trick" data-testid="game-log-trick">
                  <span className="game-log-trick-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <ul className="game-log-plays" aria-hidden="true">
                    {trick.plays.map((play) => (
                      <li
                        key={play.seat}
                        className="game-log-play"
                        data-testid="game-log-play"
                        data-seat={play.seat}
                        data-led={play.seat === trick.leader || undefined}
                        data-winner={play.seat === trick.winner || undefined}
                      >
                        <CardFace card={play.card} compact />
                        <span className="game-log-play-name">
                          <PlayerName seat={play.seat} viewerSeat={us} names={names} />
                        </span>
                      </li>
                    ))}
                  </ul>
                  <span className="visually-hidden" data-testid="game-log-trick-text">
                    Trick {i + 1}: <PlayerName seat={trick.leader} viewerSeat={us} names={names} />{' '}
                    led, <PlayerName seat={trick.winner} viewerSeat={us} names={names} /> won
                  </span>
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
