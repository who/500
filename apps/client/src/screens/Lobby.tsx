/**
 * Lobby screen (PRD section 6.1 screen 2): the room code with a copy-link
 * affordance, four seats arranged around a table, seat claiming, and the
 * host-only controls — per-non-human-seat bot difficulty and start. Seats
 * render relative to YOUR seat at the bottom (the table-screen convention);
 * before you sit, seat 0 anchors the bottom.
 */

import { useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { BotDifficulty, RoomSeatView } from '@five-hundred/protocol';
import { BOT_DIFFICULTIES } from '@five-hundred/protocol';
import { useGameClient } from './router.tsx';

const POSITIONS = ['bottom', 'left', 'top', 'right'] as const;

const DIFFICULTY_LABELS: Record<BotDifficulty, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
};

function shareUrl(roomCode: string): string {
  if (typeof location === 'undefined') return `#/room/${roomCode}`;
  return `${location.origin}${location.pathname}#/room/${roomCode}`;
}

export function Lobby(): ReactNode {
  const client = useGameClient();
  const room = useStore(client.store, (s) => s.roomView);
  const mySeat = useStore(client.store, (s) => s.seat);
  const lastError = useStore(client.store, (s) => s.lastError);
  const [copied, setCopied] = useState(false);

  if (room === null) return null; // the router only mounts Lobby with a room

  const isHost = mySeat !== null && room.hostSeat === mySeat;
  const anchor = mySeat ?? 0;

  function handleCopy(): void {
    if (room === null) return;
    const url = shareUrl(room.roomCode);
    void navigator.clipboard?.writeText(url).then(
      () => setCopied(true),
      () => {},
    );
  }

  function handleSit(seat: number): void {
    client.store.getState().clearError();
    client.send({ t: 'sit', seat });
  }

  function handleDifficulty(seat: number, difficulty: BotDifficulty): void {
    client.send({ t: 'configureBots', bots: [{ seat, difficulty }] });
  }

  function renderSeat(seat: RoomSeatView): ReactNode {
    const isYou = mySeat === seat.seat;
    return (
      <div className="seat-card">
        <div className="seat-title">
          {seat.occupant === 'human' && (
            <>
              <strong>{seat.name}</strong>
              {isYou && <span className="tag">You</span>}
              {room !== null && room.hostSeat === seat.seat && <span className="tag">Host</span>}
              {!seat.connected && <span className="tag warn">Disconnected</span>}
            </>
          )}
          {seat.occupant === 'bot' && <strong>Bot</strong>}
          {seat.occupant === 'empty' && <em>Open seat</em>}
        </div>
        {seat.occupant !== 'human' && (
          <select
            aria-label={`Seat ${seat.seat + 1} bot difficulty`}
            value={seat.difficulty ?? 'medium'}
            disabled={!isHost}
            onChange={(e) => handleDifficulty(seat.seat, e.target.value as BotDifficulty)}
          >
            {BOT_DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {DIFFICULTY_LABELS[d]}
              </option>
            ))}
          </select>
        )}
        {seat.occupant === 'empty' && !isYou && (
          <button type="button" onClick={() => handleSit(seat.seat)}>
            {mySeat === null ? 'Sit here' : 'Move here'}
          </button>
        )}
      </div>
    );
  }

  return (
    <main data-screen="lobby" className="screen">
      <header className="room-code">
        <h1>
          Room <strong data-testid="room-code">{room.roomCode}</strong>
        </h1>
        <button type="button" onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy invite link'}
        </button>
      </header>

      <div className="table-area">
        <div className="table-felt" aria-hidden="true" />
        {POSITIONS.map((position, offset) => {
          const seat = room.seats[(anchor + offset) % 4];
          if (seat === undefined) return null;
          return (
            <div
              key={position}
              className={`seat seat-${position}`}
              data-seat={seat.seat}
              data-position={position}
            >
              {renderSeat(seat)}
            </div>
          );
        })}
      </div>

      <footer className="lobby-controls">
        {isHost ? (
          <button
            type="button"
            className="primary"
            onClick={() => client.send({ t: 'startGame' })}
          >
            Start game
          </button>
        ) : (
          <p className="notice">
            {mySeat === null && 'Tap an open seat to join the table. '}
            Waiting for the host to start…
          </p>
        )}
      </footer>

      {lastError !== null && (
        <p role="alert" className="error">
          {lastError.message}
        </p>
      )}
    </main>
  );
}
