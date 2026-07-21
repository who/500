/**
 * Table screen (PRD section 6.1 screen 3): your sorted, fanned hand at the
 * bottom, the three other seats as badges with hidden-hand backs, the
 * current trick in the center, and the persistent HUD. Pure presentation —
 * bidding, the exchange picker, and click-to-play land in sibling leaves
 * that mount inside this screen.
 */

import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import type { RoomView } from '@five-hundred/protocol';
import { seatPosition } from '../lib/seating.ts';
import { sortHand } from '../lib/handSort.ts';
import { CardFace, cardLabel } from '../components/Card.tsx';
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
  if (seatView === null) return null; // the router only mounts Table with a view

  const view = seatView.view;
  const me = view.seat;
  const hand = sortHand(view.hand, view.contract);
  // Spread the fan across a fixed arc so 15/16-card exchange hands stay legible.
  const fanStep = hand.length > 1 ? Math.min(6, 40 / (hand.length - 1)) : 0;

  function badge(seat: number): ReactNode {
    return (
      <SeatBadge
        name={seatName(room, seat)}
        isYou={seat === me}
        isDealer={view.dealer === seat}
        isActing={view.toAct === seat}
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
        <TrickArea trick={view.trick} anchor={me} />
      </div>
      <div className="my-seat" data-seat={me}>
        {badge(me)}
        <div className="my-hand" data-testid="my-hand" aria-label="Your hand">
          {hand.map((card, i) => (
            <div
              key={card}
              className="hand-card"
              style={{ rotate: `${(i - (hand.length - 1) / 2) * fanStep}deg` }}
              title={cardLabel(card)}
            >
              <CardFace card={card} />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
