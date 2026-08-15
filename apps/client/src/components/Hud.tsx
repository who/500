/**
 * Persistent heads-up strip (PRD section 6.1 screen 3): contract and
 * declarer, tricks per side as "Us N – Them N", running game scores, and
 * the bid value at stake. "Us" is always the viewer's side (seat % 2).
 * Lose-all contracts (nulla / double nulla, PRD 6.2) flip the framing: the
 * contract line spells out the goal and the trick counter tracks tricks
 * forced onto the bidders, who want zero.
 * Once the bidders are set (fh-d2d) the trick counter says so, from the same
 * predicate the felt's reddish border reads.
 */

import type { ReactNode } from 'react';
import { type RedactedView, NULLA, bidValue, isLoseAll } from '@five-hundred/engine';
import { biddersAreSet } from '../lib/biddersSet.ts';
import { contractToken } from '../lib/contractToken.ts';

export function Hud(props: {
  view: RedactedView;
  names: readonly string[];
  onLeave?: () => void;
}): ReactNode {
  const { view, names } = props;
  const us = view.seat % 2;
  const them = 1 - us;
  const contract = view.contract;
  const loseAll = contract !== null && isLoseAll(contract);
  // A declared slam plays for all 10 at a flat 500 (engine scoreHand).
  const stake = contract === null ? null : view.slam ? 500 : bidValue(contract);
  // Tricks the defenders have forced onto the bidding side (they want 0).
  const bidderTricks = view.declarer === null ? 0 : (view.sideTricks[view.declarer % 2] ?? 0);
  const set = biddersAreSet(view);
  return (
    <header className="hud">
      <div className="hud-cell hud-contract" data-testid="hud-contract">
        {contract === null ? (
          <em>No contract yet</em>
        ) : loseAll ? (
          <>
            <strong>{contractToken(contract, view.slam)}</strong>
            {view.declarer !== null && <span> by {names[view.declarer]}</span>}
            <span>
              {' '}
              — {contract.kind === NULLA ? 'must lose every trick' : 'both must lose every trick'}
            </span>
          </>
        ) : (
          <>
            <strong>{contractToken(contract, view.slam)}</strong>
            {view.declarer !== null && <span> by {names[view.declarer]}</span>}
          </>
        )}
      </div>
      <div
        className={set ? 'hud-cell hud-tricks hud-set' : 'hud-cell hud-tricks'}
        data-testid="hud-tricks"
        data-bidders-set={set || undefined}
      >
        {loseAll
          ? `Tricks taken by bidders: ${bidderTricks} — they want 0`
          : `Us ${view.sideTricks[us]} – Them ${view.sideTricks[them]}`}
        {set && <strong className="hud-set-tag"> — bidders set</strong>}
      </div>
      <div className="hud-cell hud-scores" data-testid="hud-scores">
        Score {view.scores[us]} / {view.scores[them]}
      </div>
      {stake !== null && (
        <div className="hud-cell hud-stake" data-testid="hud-stake">
          At stake: {stake}
        </div>
      )}
      {props.onLeave !== undefined && (
        <button type="button" className="hud-leave" title="Back to menu" onClick={props.onLeave}>
          Leave
        </button>
      )}
    </header>
  );
}
