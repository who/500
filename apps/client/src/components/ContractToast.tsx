/**
 * Contract-won announcement (fh-8kz): the beat between the auction ending and
 * the first lead. The HUD carries contract+declarer persistently, but a
 * persistent strip does not mark a transition — especially when a bot wins
 * and the human, as a defender, would otherwise watch play slide straight
 * into the bot's middle exchange and trick 1.
 *
 * Built on the RedealToast idiom: a status toast keyed on a count (here the
 * hand number) that auto-dismisses, so back-to-back hands replace rather than
 * queue. The two are mutually exclusive by construction — a redeal means no
 * contract, so the store clears the redeal notice when a contract lands.
 *
 * Contracts are spelled out ("8 Diamonds", "Double Nulla") rather than using
 * the HUD's compact "8D" — an announcement is read once, in passing.
 */

import { useEffect, type ReactNode } from 'react';
import { type Bid, DNULLA, NULLA, NUM, bidValue } from '@five-hundred/engine';

export const CONTRACT_TOAST_MS = 5000;

/** Index by strain, so index 4 (NT) reads "No Trumps". */
const STRAIN_WORDS = ['Spades', 'Clubs', 'Diamonds', 'Hearts', 'No Trumps'] as const;

/** Long-form contract name for the announcement: "8 Diamonds", "Nulla". */
export function spelledContract(contract: Bid): string {
  if (contract.kind === NULLA) return 'Nulla';
  if (contract.kind === DNULLA) return 'Double Nulla';
  if (contract.kind === NUM)
    return `${contract.level} ${STRAIN_WORDS[contract.strain] ?? ''}`.trim();
  return contract.kind;
}

export interface ContractToastProps {
  contract: Bid;
  /** Display name of the declaring seat, ignored when `isYou`. */
  declarerName: string;
  /** True when the viewer won the auction — announced as "You". */
  isYou: boolean;
  /** A declared slam (raised after the offer, while the toast is still up). */
  slam: boolean;
  /** Hand number from the view; a new value restarts the dismiss timer. */
  count: number;
  onDismiss(): void;
}

export function ContractToast(props: ContractToastProps): ReactNode {
  const { contract, count, onDismiss, slam } = props;
  useEffect(() => {
    const timer = setTimeout(onDismiss, CONTRACT_TOAST_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [count, onDismiss]);
  // Slam stake matches the HUD's: a flat 500, won or lost in full.
  const stake = slam ? 500 : bidValue(contract);
  const name = slam ? `Slam ${spelledContract(contract)}` : spelledContract(contract);
  return (
    <div className="contract-toast" role="status" data-testid="contract-toast" data-count={count}>
      {props.isYou ? 'You' : props.declarerName} won the bid — {name} ({stake} at stake)
    </div>
  );
}
