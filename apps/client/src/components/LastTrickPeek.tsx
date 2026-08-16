/**
 * "Last trick" peek (PRD 6.2 trick flow): a small toggle by the trick area
 * popping over the previous completed trick — seat-labelled cards with the
 * winner ringed — so a play that cleared before the viewer caught it can be
 * reviewed. Only the immediately previous trick is kept (PRD non-goal: no
 * replay of older tricks). While a popped trick goes stale (the next trick
 * resolves) the popover live-updates to the newer one — it is always exactly
 * view.lastTrick.
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { Trick } from '@five-hundred/engine';
import { CardFace } from './Card.tsx';
import { PlayerName } from './PlayerName.tsx';

export function LastTrickPeek(props: {
  trick: Trick | null;
  /** Display names indexed by seat. */
  names: readonly string[];
  /** The viewer's seat, for the We/They name tint (fh-58m). */
  viewerSeat: number;
}): ReactNode {
  const [open, setOpen] = useState(false);
  // A new hand clears the history; don't reopen over its first trick.
  const empty = props.trick === null;
  useEffect(() => {
    if (empty) setOpen(false);
  }, [empty]);
  if (props.trick === null) return null;
  const trick = props.trick;
  return (
    <div className="last-trick-peek">
      <button
        type="button"
        className="last-trick-toggle"
        data-testid="last-trick-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Last trick
      </button>
      {open && (
        <div
          className="last-trick-popover"
          data-testid="last-trick-popover"
          role="dialog"
          aria-label="Last trick"
        >
          <ul>
            {trick.plays.map((play) => (
              <li
                key={play.seat}
                data-seat={play.seat}
                data-winner={play.seat === trick.winner || undefined}
              >
                <CardFace card={play.card} />
                <span className="peek-name">
                  <PlayerName seat={play.seat} viewerSeat={props.viewerSeat} names={props.names} />
                </span>
              </li>
            ))}
          </ul>
          <p className="peek-caption" data-testid="last-trick-winner">
            Won by <PlayerName seat={trick.winner} viewerSeat={props.viewerSeat} names={props.names} />
          </p>
        </div>
      )}
    </div>
  );
}
