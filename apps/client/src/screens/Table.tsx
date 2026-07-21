/**
 * Table screen (PRD section 6.1 screen 3): your sorted, fanned hand at the
 * bottom, the three other seats as badges with hidden-hand backs, the
 * current trick in the center, and the persistent HUD. This leaf adds card
 * play: legality straight from the server's actionRequest, illegal cards
 * dimmed with a reason, a submit lock until the next gameView, and the
 * resolved-trick winner highlight. During middleExchange the acting seat's
 * hand is replaced by the discard picker while everyone else sees the
 * abstract pickup status (PRD 6.3 — the middle stays hidden information).
 * Bidding lands in a sibling leaf that mounts inside this screen.
 */

import { useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { Card } from '@five-hundred/engine';
import type { ActionRequestEvent, ErrorEvent, RoomView } from '@five-hundred/protocol';
import { seatPosition } from '../lib/seating.ts';
import { sortHand } from '../lib/handSort.ts';
import { playLegality } from '../lib/playLegality.ts';
import { ExchangePicker } from '../components/ExchangePicker.tsx';
import { Hand } from '../components/Hand.tsx';
import { HandEndOverlay } from '../components/HandEndOverlay.tsx';
import { Hud } from '../components/Hud.tsx';
import { SeatBadge } from '../components/SeatBadge.tsx';
import { TrickArea } from '../components/TrickArea.tsx';
import { useGameClient } from './router.tsx';

/** Display name for a seat: the human's name, else a bot label. */
export function seatName(room: RoomView | null, seat: number): string {
  const entry = room?.seats[seat];
  if (entry !== undefined && entry.occupant === 'human' && entry.name !== null) return entry.name;
  return `Bot ${seat + 1}`;
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
  // The actionRequest a submission was made against; while it is still the
  // current one the hand stays locked (a gameView clears pendingActions, so
  // the reference changing is exactly "the next view arrived"). A fresh
  // server error also releases the lock — the submission was rejected, so
  // the seat must be able to act again.
  const [lockedOn, setLockedOn] = useState<SubmitLock | null>(null);
  if (seatView === null) return null; // the router only mounts Table with a view

  const view = seatView.view;
  const me = view.seat;
  const hand = sortHand(view.hand, view.contract);
  const legality = playLegality(view, pendingActions?.actions ?? null);
  const locked =
    lockedOn !== null && lockedOn.req === pendingActions && lockedOn.err === lastError;
  const exchanging = view.phase === 'middleExchange';
  const picking = exchanging && view.toAct === me;

  function playCard(card: Card): void {
    if (pendingActions === null) return;
    client.send({ t: 'playCard', card });
    setLockedOn({ req: pendingActions, err: lastError });
  }

  function confirmKeeps(keeps: readonly Card[]): void {
    if (pendingActions === null) return;
    client.send({ t: 'discardKeeps', keeps });
    setLockedOn({ req: pendingActions, err: lastError });
  }

  function badge(seat: number): ReactNode {
    return (
      <SeatBadge
        name={seatName(room, seat)}
        isYou={seat === me}
        isDealer={view.dealer === seat}
        isActing={view.toAct === seat}
        thinking={seat !== me && room?.seats[seat]?.occupant !== 'human'}
        sittingOut={!view.activeSeats.includes(seat)}
        cardCount={view.handCounts[seat] ?? 0}
        showBacks={seat !== me}
      />
    );
  }

  return (
    <main data-screen="table" className="screen table-screen">
      <Hud view={view} names={[0, 1, 2, 3].map((s) => seatName(room, s))} />
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
        <TrickArea trick={view.trick} lastTrick={view.lastTrick} anchor={me} />
        {exchanging && view.toAct !== null && view.toAct !== me && (
          <div className="exchange-status" role="status" data-testid="exchange-status">
            {seatName(room, view.toAct)} picked up the middle and is discarding{' '}
            {Math.max(0, (view.handCounts[view.toAct] ?? 10) - 10)}…
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
        {picking ? (
          <ExchangePicker
            cards={hand}
            locked={locked || pendingActions === null}
            onConfirm={confirmKeeps}
          />
        ) : (
          <Hand
            cards={hand}
            active={legality.active}
            legal={legality.legal}
            reasons={legality.reasons}
            locked={locked}
            onPlay={playCard}
          />
        )}
      </div>
      {view.phase === 'handScored' && view.handResult !== null && (
        <HandEndOverlay
          result={view.handResult}
          scores={view.scores}
          seat={me}
          readySeats={readySeats}
          room={room}
          names={[0, 1, 2, 3].map((s) => seatName(room, s))}
          onReady={() => client.send({ t: 'nextHand' })}
        />
      )}
    </main>
  );
}
