/**
 * Team-colored player-name mention (fh-58m): every rendered name goes through
 * here, so the We/They side derivation lives in exactly one place. Side is
 * viewer-relative — partnerships are seat parity (seat % 2), the viewer's
 * parity is "us" — and only parity matters, so callers that track a side
 * index rather than a seat can pass it as `viewerSeat` unchanged.
 *
 * The span carries only the display text (App.css tints via [data-side]), so
 * converting a surface never changes what its text assertions see.
 */

import type { ReactNode } from 'react';

export type TeamSide = 'us' | 'them';

/** The viewer-relative side of a seat: same parity as the viewer is us. */
export function playerSide(seat: number, viewerSeat: number): TeamSide {
  return seat % 2 === viewerSeat % 2 ? 'us' : 'them';
}

export function PlayerName(props: {
  /** The seat being named. */
  seat: number;
  /** The viewer's seat (or side index — only parity matters). */
  viewerSeat: number;
  /** Seat-indexed display names (see seatName). */
  names?: readonly string[];
  /** Pre-formatted display string ("You", a seatName pass-through); wins
   *  over names[seat]. */
  name?: string;
}): ReactNode {
  return (
    <span className="player-name" data-side={playerSide(props.seat, props.viewerSeat)}>
      {props.name ?? props.names?.[props.seat] ?? `Seat ${props.seat + 1}`}
    </span>
  );
}
