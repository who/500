/**
 * Game-end screen (PRD section 6.1): winner, final scores oriented to the
 * viewer, an out-the-back callout when the losing side crossed -500, and the
 * host-only rematch button (same room, same seats and bots — the server
 * validates and reseeds). Non-hosts see who can start the rematch.
 */

import { useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { OUT_THE_BACK } from '@five-hundred/engine';
import { GameLogView } from '../components/GameLogView.tsx';
import { seatName } from './Table.tsx';
import { useGameClient } from './router.tsx';

function prefersReducedMotion(): boolean {
  // matchMedia can be absent outside browsers; no preference means animate.
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function GameEnd(): ReactNode {
  const client = useGameClient();
  const seatView = useStore(client.store, (s) => s.seatView);
  const room = useStore(client.store, (s) => s.roomView);
  const gameLog = useStore(client.store, (s) => s.gameLog);
  const [showLog, setShowLog] = useState(false);
  const [rated, setRated] = useState<'up' | 'down' | null>(null);
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

  // One verdict per game (fh-y2a.3): the first click sends, then both thumbs
  // lock and the recorded choice is echoed back. The server keys the verdict
  // to the finished game, so there is nothing to re-enable client-side.
  function rateBots(verdict: 'up' | 'down'): void {
    if (rated !== null) return;
    client.send({ t: 'rateBots', verdict });
    setRated(verdict);
  }

  // The fade-in gets its class only when motion is welcome, so reduced-motion
  // viewers mount the screen at full opacity with no transition at all.
  const rootClass = prefersReducedMotion()
    ? 'screen game-end-screen'
    : 'screen game-end-screen game-end-fade';

  return (
    <main data-screen="game-end" className={rootClass}>
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
      <div className="game-end-feedback" data-testid="bot-feedback">
        <span>How did the bots play?</span>
        <button
          type="button"
          data-testid="rate-bots-up"
          aria-label="Thumbs up for the bots"
          aria-pressed={rated === 'up'}
          disabled={rated !== null}
          onClick={() => rateBots('up')}
        >
          👍
        </button>
        <button
          type="button"
          data-testid="rate-bots-down"
          aria-label="Thumbs down for the bots"
          aria-pressed={rated === 'down'}
          disabled={rated !== null}
          onClick={() => rateBots('down')}
        >
          👎
        </button>
        <span role="status" data-testid="rate-bots-status">
          {rated === null ? '' : `Thanks — thumbs ${rated} recorded.`}
        </span>
      </div>
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
        <button
          type="button"
          data-testid="game-end-review"
          onClick={() => client.store.getState().setReviewingTable(true)}
        >
          Review the table
        </button>
        {gameLog !== null && (
          <button
            type="button"
            data-testid="game-end-log"
            onClick={() => setShowLog((on) => !on)}
          >
            {showLog ? 'Hide game log' : 'Game log'}
          </button>
        )}
        <button type="button" title="Back to menu" onClick={handleLeave}>
          Leave
        </button>
      </div>
      {showLog && gameLog !== null && (
        <GameLogView
          hands={gameLog}
          names={[0, 1, 2, 3].map((s) => seatName(room, s))}
          us={us}
        />
      )}
    </main>
  );
}
