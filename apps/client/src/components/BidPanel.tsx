/**
 * Auction bid panel (PRD 6.3): a ladder-aware picker that replaces the trick
 * area while the auction runs. The grid keeps every numbered cell (rows 7-10
 * by strain columns S/C/D/H/NT) with Nulla and Double Nulla wedged in at
 * their ladder positions, each cell showing its avondale value; illegal cells
 * are disabled, never hidden, so the layout stays spatially stable as the
 * ladder climbs. Every seat sees the panel (spectating the auction) but only
 * the seat holding the bid turn can press anything.
 *
 * Legality is never recomputed client-side: a cell is enabled exactly when
 * the server's actionRequest carried that bid for this seat. The IND slot is
 * a disabled placeholder here — the M6 indication leaf activates it along
 * with tooltips and bid history.
 */

import type { ReactNode } from 'react';
import {
  type Action,
  type Bid,
  type RedactedView,
  DNULLA,
  NT,
  NULLA,
  NUM,
  PASS,
  bid,
  bidKey,
  bidName,
  bidValue,
} from '@five-hundred/engine';
import { SUIT_GLYPHS } from './Card.tsx';

const STRAIN_LABELS = [...SUIT_GLYPHS, 'NT'] as const;

export interface BidLegality {
  /** True when the viewer holds the bid turn and the panel is interactive. */
  readonly active: boolean;
  /** bidKey of every bid a tap may submit right now (empty when inactive). */
  readonly legal: ReadonlySet<string>;
}

const INERT: BidLegality = { active: false, legal: new Set() };

/**
 * Fold the server's actionRequest into panel legality for the viewer.
 * `actions` is the latest actionRequest payload (null or another seat's when
 * someone else holds the turn).
 */
export function bidLegality(view: RedactedView, actions: readonly Action[] | null): BidLegality {
  if (view.phase !== 'auction' || view.toAct !== view.seat) return INERT;
  const legal = new Set<string>();
  for (const action of actions ?? []) {
    if (action.type === 'bid' && action.seat === view.seat) legal.add(bidKey(action.bid));
  }
  return legal.size > 0 ? { active: true, legal } : INERT;
}

/** Short cell label, e.g. "8♥", "Nulla", "Pass". */
function cellName(b: Bid): string {
  if (b.kind === NUM) return `${b.level}${STRAIN_LABELS[b.strain]}`;
  if (b.kind === NULLA) return 'Nulla';
  if (b.kind === DNULLA) return 'Double Nulla';
  return 'Pass';
}

export interface BidPanelProps {
  /** True when the viewer holds the bid turn. */
  active: boolean;
  /** bidKey of each currently legal bid (see bidLegality). */
  legal: ReadonlySet<string>;
  /** True between submitting a bid and the next view. */
  locked: boolean;
  onBid(b: Bid): void;
}

export function BidPanel(props: BidPanelProps): ReactNode {
  function cell(b: Bid, className?: string): ReactNode {
    const key = bidKey(b);
    const enabled = props.active && !props.locked && props.legal.has(key);
    const value = bidValue(b);
    return (
      <button
        key={key}
        type="button"
        className={['bid-cell', className].filter(Boolean).join(' ')}
        data-bid={key}
        disabled={!enabled}
        title={bidName(b)}
        onClick={() => {
          if (enabled) props.onBid(b);
        }}
      >
        <span className="bid-cell-name">{cellName(b)}</span>
        {value > 0 && <span className="bid-cell-value">{value}</span>}
      </button>
    );
  }

  const strains = [0, 1, 2, 3, NT];
  return (
    <div
      className="bid-panel"
      data-testid="bid-panel"
      data-active={props.active || undefined}
      role="group"
      aria-label="Auction bids"
    >
      <div className="bid-grid">
        {STRAIN_LABELS.map((label) => (
          <div key={label} className="bid-col-head" aria-hidden="true">
            {label}
          </div>
        ))}
        {strains.map((s) => cell(bid(NUM, 7, s)))}
        {/* Nulla outbids every 7 and loses to every 8: a full-width divider. */}
        {cell(bid(NULLA), 'bid-span-row')}
        {strains.map((s) => cell(bid(NUM, 8, s)))}
        {strains.map((s) => cell(bid(NUM, 9, s)))}
        {/* Double nulla splits row 10 (beats 10D, loses to 10H); 10H/10NT
            keep their strain columns on the overflow row below it. */}
        {cell(bid(NUM, 10, 0))}
        {cell(bid(NUM, 10, 1))}
        {cell(bid(NUM, 10, 2))}
        {cell(bid(DNULLA), 'bid-dnulla')}
        {cell(bid(NUM, 10, 3), 'bid-col-h')}
        {cell(bid(NUM, 10, NT), 'bid-col-nt')}
      </div>
      <div className="bid-actions">
        <button
          type="button"
          className="bid-cell bid-ind"
          data-bid="IND"
          disabled
          title="Indication bids arrive in a later update"
        >
          Indicate
        </button>
        {cell(bid(PASS), 'bid-pass')}
      </div>
    </div>
  );
}
