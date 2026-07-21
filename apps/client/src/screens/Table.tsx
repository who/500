/**
 * Table screen (PRD section 6.1 screen 3): your sorted, fanned hand at the
 * bottom, the three other seats as badges with hidden-hand backs, the
 * current trick in the center, and the persistent HUD. This leaf adds card
 * play: legality straight from the server's actionRequest, illegal cards
 * dimmed with a reason, a submit lock until the next gameView, and the
 * resolved-trick winner highlight. Bidding and the exchange picker land in
 * sibling leaves that mount inside this screen.
 */

import { useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { Card } from '@five-hundred/engine';
import type { ActionRequestEvent, RoomView } from '@five-hundred/protocol';
import { seatPosition } from '../lib/seating.ts';
import { sortHand } from '../lib/handSort.ts';
import { playLegality } from '../lib/playLegality.ts';
import { Hand } from '../components/Hand.tsx';
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

export function Table(): ReactNode {
  const client = useGameClient();
  const seatView = useStore(client.store, (s) => s.seatView);
  const room = useStore(client.store, (s) => s.roomView);
  const pendingActions = useStore(client.store, (s) => s.pendingActions);
  // The actionRequest a play was submitted against; while it is still the
  // current one the hand stays locked (a gameView clears pendingActions, so
  // the reference changing is exactly "the next view arrived").
  const [lockedOn, setLockedOn] = useState<ActionRequestEvent | null>(null);
  if (seatView === null) return null; // the router only mounts Table with a view

  const view = seatView.view;
  const me = view.seat;
  const hand = sortHand(view.hand, view.contract);
  const legality = playLegality(view, pendingActions?.actions ?? null);
  const locked = lockedOn !== null && lockedOn === pendingActions;

  function playCard(card: Card): void {
    if (pendingActions === null) return;
    client.send({ t: 'playCard', card });
    setLockedOn(pendingActions);
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
      </div>
      <div className="my-seat" data-seat={me}>
        {badge(me)}
        <Hand
          cards={hand}
          active={legality.active}
          legal={legality.legal}
          reasons={legality.reasons}
          locked={locked}
          onPlay={playCard}
        />
      </div>
    </main>
  );
}
