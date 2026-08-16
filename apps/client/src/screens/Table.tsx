/**
 * Table screen (PRD section 6.1 screen 3): your sorted, fanned hand at the
 * bottom, the three other seats as badges with hidden-hand backs, the
 * current trick in the center, and the persistent HUD. This leaf adds card
 * play: legality straight from the server's actionRequest, illegal cards
 * dimmed with a reason, a submit lock until the next gameView, and the
 * resolved-trick winner highlight. During middleExchange the acting seat's
 * hand is replaced by the discard picker while everyone else sees the
 * abstract pickup status (PRD 6.3 — the middle stays hidden information).
 * During the auction the bid panel replaces the trick area (PRD 6.1), legal
 * cells taken straight from the server's actionRequest, each seat's badge
 * carries its ordered bid-history chips, and a dead auction raises the
 * redeal toast (PRD 6.2) via the store's redeals-counter watch. A won auction
 * raises the contract announcement (fh-8kz) from the same idiom — the store
 * watches `contract` going null -> set — so the transition into trick play
 * gets its own beat instead of sliding silently into the middle exchange.
 *
 * Lose-all contracts (PRD 6.2): the nulla partner's badge carries a
 * "(nulla)" sitting-out reason, and the double-nulla pass-through mounts
 * the same picker for the partner (15 keep 10) once the declarer confirms
 * — detected as toAct moving to the declarer's partner during a DNULLA
 * middleExchange, with distinct wait copy on both sides.
 *
 * M8 polish (PRD 6.2 trick flow, 4.3): a resolved trick lingers via the
 * store's lingerTrick freeze — views keep applying underneath so the
 * viewer's own next play is never delayed, but the hand-end overlay waits
 * the linger out — the last-trick peek pops the previous trick beside the
 * trick area, and acting bot badges grow the delayed "thinking…" pulse.
 *
 * Slam flow (PRD 6.2, 3.3): during slamDecision the declarer gets the offer
 * panel (confirm/decline two-step) above their inert 15; during partnerCard
 * a human partner gets the give-card picker with the strongest card
 * pre-suggested while everyone else sees abstract wait copy; after a slam
 * the partner's badge shows sitting-out (slam) and the declarer's discard
 * picker runs in 16-keep-10 mode.
 *
 * Set state (fh-d2d): one predicate (lib/biddersSet.ts) decides whether the
 * declaring side has already failed — mid-hand once it is mathematically
 * certain, and at hand end from the scored result — and both the felt and the
 * HUD render from it.
 *
 * Debug tools (fh-q2m): a muted strip under the hand carries the flag-this-
 * trick marker button, which pins the trick on screen (lib/flagTarget.ts)
 * into the server's end-of-game JSONL record.
 *
 * Deal choreography (fh-8t1): the first auction view of each hand (and every
 * redeal) plays packet flights before BidPanel appears; a face-down middle
 * pile sits on the felt through the auction and flies to the declarer after
 * ContractToast dismisses. Tap skips the in-flight sequence.
 */

import { useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { type Bid, type Card, DNULLA, NULLA, partnerOf, trumpOf } from '@five-hundred/engine';
import type { ActionRequestEvent, ErrorEvent, RoomView } from '@five-hundred/protocol';
import { biddersAreSet } from '../lib/biddersSet.ts';
import { useDealChoreography } from '../lib/dealChoreography.ts';
import { flagTarget, type FlagTarget } from '../lib/flagTarget.ts';
import { seatPosition } from '../lib/seating.ts';
import { sortHand } from '../lib/handSort.ts';
import { playLegality } from '../lib/playLegality.ts';
import { BidPanel, bidLegality } from '../components/BidPanel.tsx';
import { ContractToast } from '../components/ContractToast.tsx';
import { DealOverlay, MiddleFly, MiddlePile } from '../components/DealOverlay.tsx';
import { DebugPanel } from '../components/DebugPanel.tsx';
import { ExchangePicker } from '../components/ExchangePicker.tsx';
import { GiveCardPicker } from '../components/GiveCardPicker.tsx';
import { Hand } from '../components/Hand.tsx';
import { HandEndOverlay } from '../components/HandEndOverlay.tsx';
import { Hud } from '../components/Hud.tsx';
import { LastTrickPeek } from '../components/LastTrickPeek.tsx';
import { RedealToast } from '../components/RedealToast.tsx';
import { SeatBadge } from '../components/SeatBadge.tsx';
import { SlamPanel } from '../components/SlamPanel.tsx';
import { TrickArea } from '../components/TrickArea.tsx';
import { useGameClient } from './router.tsx';

/**
 * Display name for a seat: the human's name, or "AI <name>" for a bot (fh-1ni
 * — the server assigns the bare first name at seat-to-bot time; the "AI "
 * prefix is display-only). Falls back to the seat number when there is no
 * room view yet (a token rejoin straight into a game).
 */
export function seatName(room: RoomView | null, seat: number): string {
  const entry = room?.seats[seat];
  if (entry !== undefined && entry.name !== null) {
    return entry.occupant === 'bot' ? `AI ${entry.name}` : entry.name;
  }
  return `Seat ${seat + 1}`;
}

/** What a submission was locked against: it releases when either changes. */
interface SubmitLock {
  readonly req: ActionRequestEvent;
  readonly err: Pick<ErrorEvent, 'code' | 'message'> | null;
}

export function Table(): ReactNode {
  const client = useGameClient();
  const seatView = useStore(client.store, (s) => s.seatView);
  const room = useStore(client.store, (s) => s.roomView);
  const pendingActions = useStore(client.store, (s) => s.pendingActions);
  const readySeats = useStore(client.store, (s) => s.readySeats);
  const lastError = useStore(client.store, (s) => s.lastError);
  const lingerTrick = useStore(client.store, (s) => s.lingerTrick);
  const reviewingTable = useStore(client.store, (s) => s.reviewingTable);
  const redealNotice = useStore(client.store, (s) => s.redealNotice);
  const clearRedealNotice = useStore(client.store, (s) => s.clearRedealNotice);
  const contractNotice = useStore(client.store, (s) => s.contractNotice);
  const clearContractNotice = useStore(client.store, (s) => s.clearContractNotice);
  // The actionRequest a submission was made against; while it is still the
  // current one the hand stays locked (a gameView clears pendingActions, so
  // the reference changing is exactly "the next view arrived"). A fresh
  // server error also releases the lock — the submission was rejected, so
  // the seat must be able to act again.
  const [lockedOn, setLockedOn] = useState<SubmitLock | null>(null);
  const deal = useDealChoreography(seatView?.view ?? null, contractNotice !== null);
  if (seatView === null) return null; // the router only mounts Table with a view

  function handleLeave(): void {
    if (!confirm('Leave this game? Your seat becomes an AI player.')) return;
    client.send({ t: 'leaveRoom' });
    client.store.getState().leaveSession();
  }

  const view = seatView.view;
  const me = view.seat;
  const names = [0, 1, 2, 3].map((s) => seatName(room, s));
  const sorted = sortHand(view.hand, view.contract);
  const visibleCount = deal.seq === 'dealing' ? (deal.landed[me] ?? 0) : deal.seq === 'done' ? sorted.length : 10;
  const hand = sorted.slice(0, visibleCount);
  const legality = playLegality(view, pendingActions?.actions ?? null);
  const locked = lockedOn !== null && lockedOn.req === pendingActions && lockedOn.err === lastError;
  const exchanging = view.phase === 'middleExchange';
  const picking = exchanging && view.toAct === me;
  // The dnulla partner-discard step: the declarer has confirmed and their 5
  // discards travelled on, so toAct is now the declarer's partner. The view
  // states this directly (toAct + declarer + contract kind) — no card-count
  // inference needed.
  const passThrough =
    exchanging &&
    view.contract?.kind === DNULLA &&
    view.declarer !== null &&
    view.toAct === partnerOf(view.declarer);
  // Slam sub-states (both precede the declarer's discard in the engine).
  const slamOffer = view.phase === 'slamDecision' && view.declarer === me;
  const givingCard = view.phase === 'partnerCard' && view.toAct === me;
  const bidding = view.phase === 'auction';
  const bids = bidLegality(view, pendingActions?.actions ?? null);
  // The auction log stays on the view after the auction ends; the chips strip
  // (and the badge space it reserves, fh-8sw) exists only while it runs — a
  // redeal resets the log, clearing them.
  const auctionLog = bidding ? (view.auction?.history ?? []) : null;

  function playCard(card: Card, jokerSuit?: number): void {
    if (pendingActions === null) return;
    client.send(
      jokerSuit === undefined ? { t: 'playCard', card } : { t: 'playCard', card, jokerSuit },
    );
    setLockedOn({ req: pendingActions, err: lastError });
  }

  function submitBid(b: Bid): void {
    if (pendingActions === null) return;
    client.send({ t: 'bid', bid: b });
    setLockedOn({ req: pendingActions, err: lastError });
  }

  function confirmKeeps(keeps: readonly Card[]): void {
    if (pendingActions === null) return;
    client.send({ t: 'discardKeeps', keeps });
    setLockedOn({ req: pendingActions, err: lastError });
  }

  function answerSlam(declare: boolean): void {
    if (pendingActions === null) return;
    client.send({ t: declare ? 'declareSlam' : 'declineSlam' });
    setLockedOn({ req: pendingActions, err: lastError });
  }

  function giveCard(card: Card): void {
    if (pendingActions === null) return;
    client.send({ t: 'giveCard', card });
    setLockedOn({ req: pendingActions, err: lastError });
  }

  /** Debug tools (fh-q2m): pin this trick into the server's game log. */
  function flagTrick(target: FlagTarget, note?: string): void {
    client.send(
      note === undefined
        ? { t: 'flagTrick', hand: target.hand, trick: target.trick }
        : { t: 'flagTrick', hand: target.hand, trick: target.trick, note },
    );
  }

  function badge(seat: number): ReactNode {
    const declarer = view.declarer;
    const bidders = declarer !== null && seat % 2 === declarer % 2;
    return (
      <SeatBadge
        name={seatName(room, seat)}
        isYou={seat === me}
        isDealer={view.dealer === seat}
        isActing={view.toAct === seat}
        thinking={room?.seats[seat]?.occupant === 'bot'}
        sittingOut={!view.activeSeats.includes(seat)}
        sittingOutReason={view.contract?.kind === NULLA ? 'nulla' : view.slam ? 'slam' : undefined}
        cardCount={deal.seq === 'dealing' ? (deal.landed[seat] ?? 0) : (view.handCounts[seat] ?? 0)}
        showBacks={seat !== me}
        bidHistory={
          auctionLog === null
            ? undefined
            : deal.seq === 'dealing'
              ? []
              : auctionLog.filter((e) => e.seat === seat).map((e) => e.bid)
        }
        bidders={bidders}
        contract={view.contract}
        slam={view.slam}
        biddersSet={biddersAreSet(view)}
      />
    );
  }

  const skipDeal = deal.seq === 'dealing' || deal.seq === 'pickup';

  return (
    <main
      data-screen="table"
      className="screen table-screen"
      data-deal={deal.seq}
      onClick={skipDeal ? () => deal.skip() : undefined}
    >
      <Hud view={view} names={names} onLeave={handleLeave} />
      {/* Game-end review (fh-y2a.1): the table is read-only here (gameOver has
          no pendingActions), so the only control is the way back. */}
      {view.phase === 'gameOver' && reviewingTable && (
        <button
          type="button"
          className="review-return"
          data-testid="review-return"
          onClick={() => client.store.getState().setReviewingTable(false)}
        >
          Back to results
        </button>
      )}
      {redealNotice !== null && (
        <RedealToast
          dealerName={seatName(room, redealNotice.dealer)}
          count={redealNotice.count}
          onDismiss={clearRedealNotice}
        />
      )}
      {/* The auction->play beat (fh-8kz): who won, and at what. */}
      {contractNotice !== null && view.contract !== null && (
        <ContractToast
          contract={view.contract}
          declarerName={seatName(room, contractNotice.declarer)}
          isYou={contractNotice.declarer === me}
          slam={view.slam}
          count={contractNotice.count}
          onDismiss={clearContractNotice}
        />
      )}
      <div className="game-table">
        {[1, 2, 3].map((offset) => {
          const seat = (me + offset) % 4;
          return (
            <div
              key={seat}
              className={`table-seat table-seat-${seatPosition(seat, me)}`}
              data-seat={seat}
            >
              {badge(seat)}
            </div>
          );
        })}
        {bidding && deal.showBidUi ? (
          <BidPanel
            active={bids.active}
            legal={bids.legal}
            locked={locked}
            redealPass={view.dealer === me && (view.auction?.declarer ?? null) === null}
            onBid={submitBid}
          />
        ) : bidding ? (
          <div className="trick-area deal-felt" data-testid="deal-felt" />
        ) : (
          <>
            <TrickArea
              trick={view.trick}
              lastTrick={view.lastTrick}
              linger={lingerTrick}
              anchor={me}
              trump={view.contract === null ? null : trumpOf(view.contract)}
              biddersSet={biddersAreSet(view)}
              handNumber={view.handNumber}
              tricksPlayed={view.tricksPlayed}
            />
            <LastTrickPeek trick={view.lastTrick} names={names} />
          </>
        )}
        {/* middle-pile: five CardBacks stay on the felt through the auction. */}
        {deal.showMiddle && <MiddlePile count={deal.middleLanded} />}
        {deal.seq === 'dealing' && (
          <DealOverlay
            dealer={view.dealer}
            packets={deal.packets}
            seed={deal.seed}
            onLand={deal.landPacket}
            onComplete={deal.completeDeal}
          />
        )}
        {deal.seq === 'pickup' && view.declarer !== null && (
          <MiddleFly declarer={view.declarer} seed={deal.seed} onComplete={deal.completePickup} />
        )}
        {exchanging && !deal.holdPostAuction && view.toAct !== null && view.toAct !== me && (
          <div className="exchange-status" role="status" data-testid="exchange-status">
            {passThrough
              ? view.declarer === me
                ? `You passed 5 cards to ${seatName(room, view.toAct)} — waiting for their discards…`
                : `${seatName(room, view.declarer ?? 0)} passed 5 cards to ${seatName(room, view.toAct)}, who is discarding…`
              : `${seatName(room, view.toAct)} picked up the middle and is discarding ${Math.max(0, (view.handCounts[view.toAct] ?? 10) - 10)}…`}
          </div>
        )}
        {view.phase === 'slamDecision' && !slamOffer && !deal.holdPostAuction && (
          <div className="exchange-status" role="status" data-testid="slam-status">
            {seatName(room, view.declarer ?? 0)} is considering a slam…
          </div>
        )}
        {view.phase === 'partnerCard' && !givingCard && !deal.holdPostAuction && view.declarer !== null && (
          <div className="exchange-status" role="status" data-testid="slam-status">
            {view.declarer === me
              ? `Slam declared — waiting for ${seatName(room, partnerOf(view.declarer))} to give you their best card…`
              : `${seatName(room, partnerOf(view.declarer))} is giving their best card to ${seatName(room, view.declarer)}…`}
          </div>
        )}
      </div>
      <div className="my-seat" data-seat={me}>
        {badge(me)}
        {picking && lastError !== null && (
          <div className="exchange-error" role="alert" data-testid="exchange-error">
            {lastError.message}
          </div>
        )}
        {bidding && bids.active && lastError !== null && (
          <div className="exchange-error" role="alert" data-testid="bid-error">
            {lastError.message}
          </div>
        )}
        {(slamOffer || givingCard) && lastError !== null && (
          <div className="exchange-error" role="alert" data-testid="slam-error">
            {lastError.message}
          </div>
        )}
        {slamOffer && !deal.holdPostAuction && view.contract !== null && (
          <SlamPanel
            contract={view.contract}
            locked={locked || pendingActions === null}
            onDeclare={() => answerSlam(true)}
            onDecline={() => answerSlam(false)}
          />
        )}
        {picking && !deal.holdPostAuction ? (
          <ExchangePicker
            cards={hand}
            maxKeep={10}
            intro={
              passThrough
                ? 'Your partner passed you 5 cards'
                : view.slam
                  ? 'Slam — your partner gave you their best card'
                  : undefined
            }
            locked={locked || pendingActions === null}
            onConfirm={confirmKeeps}
          />
        ) : givingCard ? (
          <GiveCardPicker
            cards={hand}
            trump={view.contract === null ? null : trumpOf(view.contract)}
            locked={locked || pendingActions === null}
            onGive={giveCard}
          />
        ) : (
          <Hand
            cards={hand}
            active={legality.active}
            legal={legality.legal}
            needsSuit={legality.needsSuit}
            reasons={legality.reasons}
            locked={locked}
            trump={view.contract === null ? null : trumpOf(view.contract)}
            onPlay={playCard}
          />
        )}
        <DebugPanel target={flagTarget(view)} onFlag={flagTrick} />
      </div>
      {/* The overlay waits out a linger so a hand-ending trick gets its beat. */}
      {view.phase === 'handScored' && view.handResult !== null && lingerTrick === null && (
        <HandEndOverlay
          result={view.handResult}
          scores={view.scores}
          seat={me}
          readySeats={readySeats}
          room={room}
          names={names}
          onReady={() => client.send({ t: 'nextHand' })}
        />
      )}
    </main>
  );
}
