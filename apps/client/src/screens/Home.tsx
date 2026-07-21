/**
 * Home screen (PRD section 6.1 screen 1): display name plus create-room and
 * join-by-code flows. The name persists in localStorage across visits; the
 * join code is prefilled from a shared #/room/CODE link. Server errors
 * (unknown code, full room, game already started) render inline.
 */

import { useState, type FormEvent, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { roomCodeFromHash, useGameClient } from './router.tsx';

export const NAME_STORAGE_KEY = 'five-hundred.name';
export const DEFAULT_NAME = 'Player';

function loadStoredName(): string {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function persistName(name: string): void {
  try {
    localStorage.setItem(NAME_STORAGE_KEY, name);
  } catch {
    // Privacy modes: the name just won't survive a reload.
  }
}

/** Paste-friendly normalization: strip whitespace, uppercase. */
function normalizeCode(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

export function Home(): ReactNode {
  const client = useGameClient();
  const connection = useStore(client.store, (s) => s.connection);
  const rejoining = useStore(client.store, (s) => s.rejoining);
  const seatLost = useStore(client.store, (s) => s.seatLost);
  const lastError = useStore(client.store, (s) => s.lastError);
  const storeName = useStore(client.store, (s) => s.name);

  const [name, setName] = useState(() => storeName ?? loadStoredName());
  const [joinCode, setJoinCode] = useState(
    () => roomCodeFromHash(typeof location === 'undefined' ? '' : location.hash) ?? '',
  );

  const ready = connection === 'open' && !rejoining;
  const displayName = name.trim() === '' ? DEFAULT_NAME : name.trim();

  function commitName(): void {
    client.store.getState().clearError();
    client.store.getState().setName(displayName);
    persistName(displayName);
  }

  function handleCreate(): void {
    commitName();
    // The creator claims seat 0 immediately: the server processes commands in
    // order, so hostSeat is set and host-only lobby controls light up.
    client.send({ t: 'createRoom', name: displayName });
    client.send({ t: 'sit', seat: 0 });
  }

  function handleJoin(event: FormEvent): void {
    event.preventDefault();
    const roomCode = normalizeCode(joinCode);
    if (roomCode === '') return;
    commitName();
    client.send({ t: 'joinRoom', roomCode, name: displayName });
  }

  return (
    <main data-screen="home" className="screen">
      <h1>Five Hundred</h1>
      {connection !== 'open' && (
        <p className="notice">{connection === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</p>
      )}
      {rejoining && <p className="notice">Rejoining your game…</p>}
      {seatLost && (
        <p className="notice">Your seat was taken over by a newer connection (another tab?).</p>
      )}

      <label className="field">
        Your name
        <input
          type="text"
          data-testid="name-input"
          value={name}
          placeholder={DEFAULT_NAME}
          maxLength={24}
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <section className="home-actions">
        <button
          type="button"
          className="primary"
          data-testid="create-room"
          disabled={!ready}
          onClick={handleCreate}
        >
          Create room
        </button>

        <form className="join" onSubmit={handleJoin}>
          <label className="field">
            Room code
            <input
              type="text"
              value={joinCode}
              placeholder="e.g. ABCDE"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setJoinCode(normalizeCode(e.target.value))}
            />
          </label>
          <button type="submit" disabled={!ready || normalizeCode(joinCode) === ''}>
            Join room
          </button>
        </form>
      </section>

      {lastError !== null && (
        <p role="alert" className="error">
          {lastError.message}
        </p>
      )}
    </main>
  );
}
