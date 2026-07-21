/**
 * Center of the table: the trick in progress, each played card offset
 * toward the seat that played it (relative to the viewer at the bottom).
 */

import type { ReactNode } from 'react';
import type { CurrentTrickView } from '@five-hundred/engine';
import { seatPosition } from '../lib/seating.ts';
import { CardFace } from './Card.tsx';

export function TrickArea(props: {
  trick: CurrentTrickView | null;
  /** The viewer's seat, anchored at the bottom. */
  anchor: number;
}): ReactNode {
  return (
    <div className="trick-area" data-testid="trick-area">
      {props.trick?.plays.map((play) => (
        <div
          key={play.seat}
          className={`trick-card trick-${seatPosition(play.seat, props.anchor)}`}
          data-seat={play.seat}
        >
          <CardFace card={play.card} />
        </div>
      ))}
    </div>
  );
}
