/**
 * One seat's nameplate on the table: name, dealer chip, turn highlight,
 * hidden-hand backs with a card count, the delayed "thinking…" pulse for an
 * acting bot (PRD 4.3), and the sitting-out ribbon (nulla / slam partner). The viewer's own seat uses it too, minus the backs — their
 * actual hand renders below it. During the auction the badge also carries
 * the seat's bid history as ordered chips (PRD 6.2): latest emphasized,
 * indications visually distinct, passes muted, capped on phone layouts with
 * a "+n" toggle that expands the full run.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { type Bid, IND, PASS, bidName } from '@five-hundred/engine';
import { IND_TOOLTIP, cellName } from './BidPanel.tsx';
import { CardBack } from './Card.tsx';

/** Chips shown before the "+n" expander takes over (phone-width budget). */
const VISIBLE_CHIPS = 3;

/**
 * An acting bot shows "thinking…" only after holding the turn this long
 * (PRD 4.3): instant bot moves stay quiet; anything slower gets the pulse.
 */
export const THINKING_DELAY_MS = 400;

export function BidChips(props: { bids: readonly Bid[] }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const hidden = props.bids.length - VISIBLE_CHIPS;
  const shown = expanded || hidden <= 0 ? props.bids : props.bids.slice(hidden);
  const offset = props.bids.length - shown.length;
  return (
    <div className="seat-bids" data-testid="bid-history" aria-label="Bids this auction">
      {hidden > 0 && !expanded && (
        <button
          type="button"
          className="bid-chip bid-chip-more"
          aria-label={`Show ${hidden} earlier bids`}
          onClick={() => {
            setExpanded(true);
          }}
        >
          +{hidden}
        </button>
      )}
      {shown.map((b, i) => {
        const latest = offset + i === props.bids.length - 1;
        const classes = [
          'bid-chip',
          b.kind === IND && 'bid-chip-ind',
          b.kind === PASS && 'bid-chip-pass',
          latest && 'bid-chip-latest',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <span
            key={offset + i}
            className={classes}
            data-bid-kind={b.kind}
            title={b.kind === IND ? `${bidName(b)}: ${IND_TOOLTIP}` : bidName(b)}
          >
            {b.kind === IND ? `${cellName(b)} ind` : cellName(b)}
          </span>
        );
      })}
    </div>
  );
}

export interface SeatBadgeProps {
  name: string;
  isYou: boolean;
  isDealer: boolean;
  /** This seat holds the turn (view.toAct). */
  isActing: boolean;
  /** Seat is a bot: while acting it grows a pulsing "thinking…" hint after
   *  THINKING_DELAY_MS. Never set for human seats. */
  thinking?: boolean;
  /** Not in activeSeats: dimmed with a "Sitting out" ribbon. */
  sittingOut: boolean;
  /** Why the seat sits out ("nulla" / "slam"); appended to the ribbon. */
  sittingOutReason?: string;
  /** Hidden-hand size; rendered as backs unless this is the viewer's seat. */
  cardCount: number;
  showBacks: boolean;
  /** This seat's auction actions in order; chips render when non-empty. */
  bidHistory?: readonly Bid[];
}

export function SeatBadge(props: SeatBadgeProps): ReactNode {
  const pondering = props.isActing && props.thinking === true;
  // Delayed reveal: the hint appears only once the bot has visibly paused.
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (!pondering) {
      setRevealed(false);
      return undefined;
    }
    const timer = setTimeout(() => setRevealed(true), THINKING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [pondering]);
  const classes = ['seat-badge', props.isActing && 'acting', props.sittingOut && 'sitting-out']
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
        {/* CSS truncates very long names; the title keeps the full text. */}
        <strong title={props.name}>{props.name}</strong>
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
      {props.bidHistory !== undefined && props.bidHistory.length > 0 && (
        <BidChips bids={props.bidHistory} />
      )}
      {pondering && revealed && (
        <span className="seat-thinking" data-testid="seat-thinking">
          thinking…
        </span>
      )}
      {props.sittingOut && (
        <span className="sitting-out-ribbon">
          Sitting out{props.sittingOutReason !== undefined && ` (${props.sittingOutReason})`}
        </span>
      )}
    </div>
  );
}
