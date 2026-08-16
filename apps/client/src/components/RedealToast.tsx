/**
 * Dead-auction toast (PRD 6.2): "No winning bid — redealing", naming the new
 * dealer so the table knows where bidding restarts. Auto-dismisses after a
 * few seconds; the timer keys on the redeal count, so a second redeal while
 * the toast is up replaces it (and restarts the clock) rather than queueing.
 */

import { useEffect, type ReactNode } from 'react';
import { PlayerName } from './PlayerName.tsx';

export const REDEAL_TOAST_MS = 4000;

export interface RedealToastProps {
  /** Display name of the seat dealing the fresh hand. */
  dealerName: string;
  /** The dealing seat, for the We/They name tint (fh-58m). */
  dealerSeat: number;
  /** The viewer's seat; same parity as the dealer tints as us. */
  viewerSeat: number;
  /** Redeal counter from the view; a new value restarts the dismiss timer. */
  count: number;
  onDismiss(): void;
}

export function RedealToast(props: RedealToastProps): ReactNode {
  const { count, onDismiss } = props;
  useEffect(() => {
    const timer = setTimeout(onDismiss, REDEAL_TOAST_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [count, onDismiss]);
  return (
    <div className="redeal-toast" role="status" data-testid="redeal-toast" data-count={count}>
      No winning bid — redealing.{' '}
      <PlayerName seat={props.dealerSeat} viewerSeat={props.viewerSeat} name={props.dealerName} />{' '}
      deals.
    </div>
  );
}
