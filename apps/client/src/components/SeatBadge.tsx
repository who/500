/**
 * One seat's nameplate on the table: name, dealer chip, turn highlight,
 * hidden-hand backs with a card count, and the sitting-out ribbon (nulla /
 * slam partner). The viewer's own seat uses it too, minus the backs — their
 * actual hand renders below it.
 */

import type { ReactNode } from 'react';
import { CardBack } from './Card.tsx';

export interface SeatBadgeProps {
  name: string;
  isYou: boolean;
  isDealer: boolean;
  /** This seat holds the turn (view.toAct). */
  isActing: boolean;
  /** Acting seat is a bot: the turn highlight doubles as a thinking hint. */
  thinking?: boolean;
  /** Not in activeSeats: dimmed with a "Sitting out" ribbon. */
  sittingOut: boolean;
  /** Hidden-hand size; rendered as backs unless this is the viewer's seat. */
  cardCount: number;
  showBacks: boolean;
}

export function SeatBadge(props: SeatBadgeProps): ReactNode {
  const classes = [
    'seat-badge',
    props.isActing && 'acting',
    props.sittingOut && 'sitting-out',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={classes}
      data-acting={props.isActing || undefined}
      data-dealer={props.isDealer || undefined}
      data-sitting-out={props.sittingOut || undefined}
    >
      <div className="seat-name">
        <strong>{props.name}</strong>
        {props.isYou && <span className="tag">You</span>}
        {props.isDealer && (
          <span className="dealer-chip" title="Dealer" aria-label="Dealer">
            D
          </span>
        )}
      </div>
      {props.showBacks && (
        <div className="seat-backs" aria-label={`${props.name}: ${props.cardCount} cards`}>
          <CardBack className="card-mini" />
          <span className="seat-count">{props.cardCount}</span>
        </div>
      )}
      {props.isActing && props.thinking === true && (
        <span className="seat-thinking" data-testid="seat-thinking">
          thinking…
        </span>
      )}
      {props.sittingOut && <span className="sitting-out-ribbon">Sitting out</span>}
    </div>
  );
}
