/**
 * One seat's nameplate on the table: name, dealer chip, turn highlight,
 * hidden-hand backs with a card count, the delayed ActivityCard "thinking"
 * ring for an acting bot (PRD 4.3), and the sitting-out ribbon (nulla / slam
 * partner). The viewer's own seat uses it too, minus the backs — their
 * actual hand renders below it. During the auction the badge also carries
 * the seat's bid history as ordered chips (PRD 6.2): latest emphasized,
 * indications visually distinct, passes muted, capped on phone layouts with
 * a "+n" toggle that expands the full run. After a contract is won the
 * declaring side also wears a reserved "Bidders · {token}" chip under the
 * badge (empty on the other seats) so awarding it cannot grow the nameplate.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { type Bid, type Card, IND, NT, NUM, PASS, bidName } from '@five-hundred/engine';
import { contractToken } from '../lib/contractToken.ts';
import { trumpFaceClass } from '../lib/trumpMark.ts';
import { ActivityCard } from './ActivityCard.tsx';
import { IND_TOOLTIP, cellName } from './BidPanel.tsx';
import { CardBack, CardFace, SuitGlyph } from './Card.tsx';
import { PlayerName } from './PlayerName.tsx';

/** Chips shown before the "+n" expander takes over (phone-width budget). */
const VISIBLE_CHIPS = 3;

/**
 * An acting bot shows it is thinking only after holding the turn this long
 * (PRD 4.3): instant bot moves stay quiet; anything slower gets the ring.
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
            {b.kind === NUM || b.kind === IND ? (
              <>
                Bid: {b.level} {b.strain === NT ? 'NT' : <SuitGlyph suit={b.strain} />}
                {b.kind === IND ? ' ind' : null}
              </>
            ) : (
              cellName(b)
            )}
          </span>
        );
      })}
    </div>
  );
}

export interface SeatBadgeProps {
  name: string;
  /** The seat this badge names, for the We/They tint (fh-58m). */
  seat: number;
  /** The viewer's seat; same parity as `seat` colors the name as us. */
  viewerSeat: number;
  isYou: boolean;
  isDealer: boolean;
  /** This seat holds the turn (view.toAct). */
  isActing: boolean;
  /** Seat is a bot: while acting it wears the ActivityCard thinking ring
   *  after THINKING_DELAY_MS. Never set for human seats. */
  thinking?: boolean;
  /** Not in activeSeats: dimmed with a "Sitting out" ribbon. */
  sittingOut: boolean;
  /** Why the seat sits out ("nulla" / "slam"); appended to the ribbon. */
  sittingOutReason?: string;
  /** Hidden-hand size; rendered as backs unless this is the viewer's seat. */
  cardCount: number;
  showBacks: boolean;
  /** This seat's card in the displayed trick (fh-dx8): the always-legible
   *  mirror of the center pile, a mini face beside the count. Null or absent
   *  renders nothing and the badge is exactly as before. */
  playedCard?: Card | null;
  /** Trump suit for the mirror's foil mark; null/absent for NT and nulla. */
  trump?: number | null;
  /** This seat's auction actions in order. When defined the chips strip
   *  renders even while empty — a fixed-size reserve (fh-8sw) so the first
   *  chip landing can't resize the badge and reflow the table. */
  bidHistory?: readonly Bid[];
  /** Declaring-side seat once a contract is won. The reserved slot still
   *  mounts when false so filling the chip cannot grow the badge. */
  bidders?: boolean;
  /** Won contract; chip copy is `Bidders · {token}` when bidders. */
  contract?: Bid | null;
  /** Declared slam: token is `Slam 8H`, matching the HUD strong text. */
  slam?: boolean;
  /** Declaring side can no longer make: the chip border uses --danger. */
  biddersSet?: boolean;
}

export function SeatBadge(props: SeatBadgeProps): ReactNode {
  const played = props.playedCard ?? null;
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
        <strong title={props.name}>
          <PlayerName seat={props.seat} viewerSeat={props.viewerSeat} name={props.name} />
        </strong>
        {props.isYou && <span className="tag">You</span>}
        {props.isDealer && (
          <span className="dealer-chip" title="Dealer" aria-label="Dealer">
            D
          </span>
        )}
      </div>
      {(props.showBacks || played !== null) && (
        <div
          className="seat-backs"
          aria-label={props.showBacks ? `${props.name}: ${props.cardCount} cards` : undefined}
        >
          {props.showBacks && (
            <>
              <CardBack className="card-mini" />
              <span className="seat-count">{props.cardCount}</span>
            </>
          )}
          {played !== null && (
            <span
              className="seat-played"
              data-testid="seat-played"
              title={`${props.name} played this to the trick`}
            >
              <CardFace
                card={played}
                compact
                className={['card-mini', trumpFaceClass(played, props.trump ?? null)]
                  .filter(Boolean)
                  .join(' ')}
              />
            </span>
          )}
        </div>
      )}
      {props.bidHistory !== undefined && <BidChips bids={props.bidHistory} />}
      {pondering && revealed && (
        <ActivityCard
          className="seat-thinking"
          testId="seat-thinking"
          label={`${props.name} is thinking`}
        />
      )}
      {props.sittingOut && (
        <span className="sitting-out-ribbon">
          Sitting out{props.sittingOutReason !== undefined && ` (${props.sittingOutReason})`}
        </span>
      )}
      <div
        className={[
          'bidders-label',
          props.bidders === true && 'bidders-label-on',
          props.bidders === true && props.biddersSet === true && 'bidders-label-set',
        ]
          .filter(Boolean)
          .join(' ')}
        data-testid="bidders-label"
        data-bidders={props.bidders === true || undefined}
        data-bidders-set={(props.bidders === true && props.biddersSet === true) || undefined}
      >
        {props.bidders === true
          ? props.contract != null
            ? `Bidders · ${contractToken(props.contract, props.slam === true)}`
            : 'Bidders'
          : null}
      </div>
    </div>
  );
}
