/**
 * Lobby screen (PRD section 6.1 screen 2): the room code with a copy-link
 * affordance, four seats arranged around a table, seat claiming, and the
 * host-only start control. Seats render relative to YOUR seat at the bottom
 * (the table-screen convention); before you sit, seat 0 anchors the bottom.
 *
 * There is no difficulty choice (fh-gpk): every seat the server fills plays
 * Hard, so a non-human seat just says so.
 */

import { useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { RoomSeatView } from '@five-hundred/protocol';
import { useGameClient } from './router.tsx';

const POSITIONS = ['bottom', 'left', 'top', 'right'] as const;

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

  function handleAdaptive(on: boolean): void {
    client.send({ t: 'setAdaptiveBots', on });
  }

  function renderSeat(seat: RoomSeatView): ReactNode {
    const isYou = mySeat === seat.seat;
    return (
      <div className="seat-card">
        <div className="seat-title">
          {seat.occupant === 'human' && (
            <>
              {/* CSS truncates very long names; the title keeps the full text. */}
              <strong title={seat.name ?? undefined}>{seat.name}</strong>
              {isYou && <span className="tag">You</span>}
              {room !== null && room.hostSeat === seat.seat && <span className="tag">Host</span>}
              {!seat.connected && <span className="tag warn">Disconnected</span>}
            </>
          )}
          {seat.occupant === 'bot' && <strong>Bot</strong>}
          {seat.occupant === 'empty' && <em>Open seat</em>}
        </div>
        {/* Bots are always Hard; an open seat becomes one when the game starts. */}
        {seat.occupant !== 'human' && (
          <p className="bot-tier" data-testid={`bot-tier-${seat.seat}`}>
            Hard bot
          </p>
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
          {room.learnedVersion != null && (
            <span
              className="tag"
              data-testid="learned-tag"
              title="Hard bots can play a self-play-tuned strategy overlay"
            >
              learned v{room.learnedVersion}
            </span>
          )}
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
        {room.learnedVersion != null && (
          <label className="adaptive-toggle" title="Hard seats play the learned overlay">
            <input
              type="checkbox"
              data-testid="adaptive-bots"
              checked={room.adaptiveBots ?? false}
              disabled={!isHost}
              onChange={(e) => handleAdaptive(e.target.checked)}
            />
            Adaptive bots
          </label>
        )}
        {isHost ? (
          <button
            type="button"
            className="primary"
            data-testid="start-game"
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
