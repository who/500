/**
 * Persistent heads-up strip (PRD section 6.1 screen 3): contract and
 * declarer, tricks per side as "Us N – Them N", running game scores, and
 * the bid value at stake. "Us" is always the viewer's side (seat % 2).
 */

import type { ReactNode } from 'react';
import { type RedactedView, bidName, bidValue } from '@five-hundred/engine';

export function Hud(props: { view: RedactedView; names: readonly string[] }): ReactNode {
  const { view, names } = props;
  const us = view.seat % 2;
  const them = 1 - us;
  const contract = view.contract;
  // A declared slam plays for all 10 at value + 250 (engine scoreHand).
  const stake = contract === null ? null : bidValue(contract) + (view.slam ? 250 : 0);
  return (
    <header className="hud">
      <div className="hud-cell hud-contract" data-testid="hud-contract">
        {contract === null ? (
          <em>No contract yet</em>
        ) : (
          <>
            <strong>{view.slam ? `Slam ${bidName(contract)}` : bidName(contract)}</strong>
            {view.declarer !== null && <span> by {names[view.declarer]}</span>}
          </>
        )}
      </div>
      <div className="hud-cell hud-tricks" data-testid="hud-tricks">
        Us {view.sideTricks[us]} – Them {view.sideTricks[them]}
      </div>
      <div className="hud-cell hud-scores" data-testid="hud-scores">
        Score {view.scores[us]} / {view.scores[them]}
      </div>
      {stake !== null && (
        <div className="hud-cell hud-stake" data-testid="hud-stake">
          At stake: {stake}
        </div>
      )}
    </header>
  );
}
