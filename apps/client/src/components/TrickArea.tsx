/**
 * Center of the table: the trick in progress, each played card offset
 * toward the seat that played it (relative to the viewer at the bottom).
 * Between tricks — after trickResolved delivers the fresh view, before the
 * next lead — the just-completed trick stays up with its winner highlighted
 * (bare minimum display; linger timing and the last-trick peek are M8).
 */

import type { ReactNode } from 'react';
import type { CurrentTrickView, Trick } from '@five-hundred/engine';
import { seatPosition } from '../lib/seating.ts';
import { CardFace } from './Card.tsx';

export function TrickArea(props: {
  trick: CurrentTrickView | null;
  /** Last completed trick (view.lastTrick); shown while the next is unled. */
  lastTrick: Trick | null;
  /** The viewer's seat, anchored at the bottom. */
  anchor: number;
}): ReactNode {
  const inProgress = props.trick !== null && props.trick.plays.length > 0;
  const resolved = !inProgress && props.lastTrick !== null ? props.lastTrick : null;
  const plays = inProgress ? (props.trick?.plays ?? []) : (resolved?.plays ?? []);
  const winner = resolved?.winner ?? null;
  return (
    <div className="trick-area" data-testid="trick-area">
      {plays.map((play) => {
        const won = play.seat === winner;
        const classes = [
          'trick-card',
          `trick-${seatPosition(play.seat, props.anchor)}`,
          won && 'trick-winner',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <div key={play.seat} className={classes} data-seat={play.seat} data-winner={won || undefined}>
            <CardFace card={play.card} />
          </div>
        );
      })}
    </div>
  );
}
