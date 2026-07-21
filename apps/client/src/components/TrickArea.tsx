/**
 * Center of the table: the trick in progress, each played card offset
 * toward the seat that played it (relative to the viewer at the bottom).
 * Between tricks — after trickResolved delivers the fresh view, before the
 * next lead — the just-completed trick stays up with its winner highlighted
 * (bare minimum display; linger timing and the last-trick peek are M8).
 * A joker led under no trump carries its declared suit as a chip on the
 * card face (PRD 6.2) — the named suit is exactly the trick's ledSuit.
 */

import type { ReactNode } from 'react';
import { type CurrentTrickView, type Trick, JOKER } from '@five-hundred/engine';
import { seatPosition } from '../lib/seating.ts';
import { CardFace, SUIT_GLYPHS } from './Card.tsx';

const SUIT_NOUNS = ['spades', 'clubs', 'diamonds', 'hearts'] as const;

export function TrickArea(props: {
  trick: CurrentTrickView | null;
  /** Last completed trick (view.lastTrick); shown while the next is unled. */
  lastTrick: Trick | null;
  /** The viewer's seat, anchored at the bottom. */
  anchor: number;
  /** Trump suit of the contract; null for NT/nulla (joker chip contexts). */
  trump: number | null;
}): ReactNode {
  const inProgress = props.trick !== null && props.trick.plays.length > 0;
  const resolved = !inProgress && props.lastTrick !== null ? props.lastTrick : null;
  const plays = inProgress ? (props.trick?.plays ?? []) : (resolved?.plays ?? []);
  const winner = resolved?.winner ?? null;
  const leader = inProgress ? (props.trick?.leader ?? null) : (resolved?.leader ?? null);
  const ledSuit = inProgress ? (props.trick?.ledSuit ?? null) : (resolved?.ledSuit ?? null);
  return (
    <div className="trick-area" data-testid="trick-area">
      {plays.map((play) => {
        const won = play.seat === winner;
        // Only a LED joker under no trump named a suit; played to a led
        // trick it silently follows, and in trump contracts it is trump.
        const declared =
          play.card === JOKER && play.seat === leader && props.trump === null && ledSuit !== null
            ? ledSuit
            : null;
        const classes = [
          'trick-card',
          `trick-${seatPosition(play.seat, props.anchor)}`,
          won && 'trick-winner',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <div
            key={play.seat}
            className={classes}
            data-seat={play.seat}
            data-winner={won || undefined}
          >
            <CardFace card={play.card} />
            {declared !== null && (
              <span
                className="joker-declares"
                data-testid="joker-declares"
                data-suit={declared}
                title={`Joker declares ${SUIT_NOUNS[declared]}`}
              >
                declares {SUIT_GLYPHS[declared]}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
