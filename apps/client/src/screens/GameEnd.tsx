/**
 * Game-end screen (PRD section 6.1): winner, final scores oriented to the
 * viewer, an out-the-back callout when the losing side crossed -500, and the
 * host-only rematch button (same room, same seats and bots — the server
 * validates and reseeds). Non-hosts see who can start the rematch.
 */

import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import { OUT_THE_BACK } from '@five-hundred/engine';
import { seatName } from './Table.tsx';
import { useGameClient } from './router.tsx';

export function GameEnd(): ReactNode {
  const client = useGameClient();
  const seatView = useStore(client.store, (s) => s.seatView);
  const room = useStore(client.store, (s) => s.roomView);
  if (seatView === null) return null;

  const view = seatView.view;
  const winner = view.winner;
  if (winner === null) return null;
  const me = view.seat;
  const us = me % 2;
  const weWon = winner === us;
  const loserScore = view.scores[1 - winner] ?? 0;
  const winnerNames = [winner, winner + 2].map((s) => seatName(room, s % 4)).join(' & ');
  const isHost = room !== null && room.hostSeat === me;
  const hostName = room?.hostSeat != null ? seatName(room, room.hostSeat) : 'the host';

  function handleLeave(): void {
    client.send({ t: 'leaveRoom' });
    client.store.getState().leaveSession();
  }

  return (
    <main data-screen="game-end" className="screen game-end-screen">
      <h1 data-testid="game-end-headline">{weWon ? 'You win!' : 'You lose'}</h1>
      <p data-testid="game-end-winners">{winnerNames} take the game.</p>
      <p className="game-end-scores" data-testid="game-end-scores">
        Final score: Us {view.scores[us]} – Them {view.scores[1 - us]}
      </p>
      {loserScore <= OUT_THE_BACK && (
        <p className="game-end-otb" data-testid="game-end-otb">
          Out the back! The losing side fell to {loserScore}.
        </p>
      )}
      <div className="game-end-actions">
        {isHost ? (
          <button
            type="button"
            data-testid="game-end-rematch"
            onClick={() => client.send({ t: 'rematch' })}
          >
            Rematch — same seats, same bots
          </button>
        ) : (
          <p data-testid="game-end-wait-host">Waiting for {hostName} to start a rematch.</p>
        )}
        <button type="button" title="Back to menu" onClick={handleLeave}>
          Leave
        </button>
      </div>
    </main>
  );
}
