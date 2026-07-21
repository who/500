/**
 * Slam offer panel (PRD 6.2): shown to the declarer of a numbered contract
 * right after the middle pickup, exactly once. The stake wording spells out
 * the all-or-nothing value up front; declaring takes a mandatory second
 * confirm tap (a slam is near game-deciding per the rules doc), while
 * declining is its own explicit command so the offer never silently lapses.
 */

import { useState, type ReactNode } from 'react';
import { type Bid, bidValue } from '@five-hundred/engine';

/** Slam stake: contract value + 250, won or lost in full (engine scoreHand). */
export function slamStake(contract: Bid): number {
  return bidValue(contract) + 250;
}

export interface SlamPanelProps {
  contract: Bid;
  /** True between submitting an answer and the next gameView. */
  locked: boolean;
  onDeclare(): void;
  onDecline(): void;
}

export function SlamPanel(props: SlamPanelProps): ReactNode {
  // Two-step declare: the first tap only opens the confirm step.
  const [confirming, setConfirming] = useState(false);
  const stake = slamStake(props.contract);
  return (
    <div
      className="slam-panel"
      role="dialog"
      aria-label="Slam offer"
      data-testid="slam-panel"
      data-locked={props.locked || undefined}
    >
      <p className="slam-offer-text" data-testid="slam-offer-text">
        Declare slam — play alone for all 10 tricks: +{stake} or -{stake}
      </p>
      {confirming ? (
        <div className="slam-actions">
          <button
            type="button"
            className="primary"
            data-testid="slam-confirm"
            disabled={props.locked}
            onClick={() => props.onDeclare()}
          >
            Confirm slam
          </button>
          <button
            type="button"
            data-testid="slam-back"
            disabled={props.locked}
            onClick={() => setConfirming(false)}
          >
            Back
          </button>
        </div>
      ) : (
        <div className="slam-actions">
          <button
            type="button"
            className="primary"
            data-testid="slam-declare"
            disabled={props.locked}
            onClick={() => setConfirming(true)}
          >
            Declare slam
          </button>
          <button
            type="button"
            data-testid="slam-decline"
            disabled={props.locked}
            onClick={() => props.onDecline()}
          >
            No slam
          </button>
        </div>
      )}
    </div>
  );
}
