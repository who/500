/**
 * Screen router keyed off store state — no URL router dependency. The phase
 * is derived: a per-seat game view means the table, a room view means the
 * lobby, otherwise home. The room code is mirrored into the URL hash
 * (#/room/CODE) purely so a shared link prefills the join code on Home.
 */

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { ClientCommand, RoomView, SeatGameView } from '@five-hundred/protocol';
import type { ClientStore } from '../store.ts';
import { GameEnd } from './GameEnd.tsx';
import { Home } from './Home.tsx';
import { Lobby } from './Lobby.tsx';
import { Table } from './Table.tsx';

/** The slice of GameClient the screens need (tests inject store + a spy). */
export interface GameClientHandle {
  store: ClientStore;
  send(command: ClientCommand): boolean;
}

const GameClientContext = createContext<GameClientHandle | null>(null);

export function GameClientProvider(props: {
  client: GameClientHandle;
  children: ReactNode;
}): ReactNode {
  return (
    <GameClientContext.Provider value={props.client}>{props.children}</GameClientContext.Provider>
  );
}

export function useGameClient(): GameClientHandle {
  const client = useContext(GameClientContext);
  if (client === null) throw new Error('useGameClient requires a GameClientProvider.');
  return client;
}

export type Phase = 'home' | 'lobby' | 'table' | 'gameEnd';

/**
 * A seat view wins over a room view so a token rejoin into a running game
 * (gameView resent on reattach) lands on the table without passing through
 * the lobby. A view resting in gameOver shows the game-end screen; a rematch
 * replaces it with a fresh auction view and the table returns.
 */
export function derivePhase(state: {
  seatView: SeatGameView | null;
  roomView: RoomView | null;
  soloStarting?: boolean;
}): Phase {
  if (state.seatView !== null) {
    return state.seatView.view.phase === 'gameOver' ? 'gameEnd' : 'table';
  }
  // Solo start holds Home so the first roomState cannot mount Lobby.
  if (state.soloStarting) return 'home';
  if (state.roomView !== null) return 'lobby';
  return 'home';
}

/** Parse #/room/CODE (any case) into an uppercase room code, else null. */
export function roomCodeFromHash(hash: string): string | null {
  const match = /^#\/room\/([A-Za-z0-9]+)\/?$/.exec(hash.trim());
  return match === null ? null : match[1].toUpperCase();
}

function syncHash(roomCode: string | null): void {
  if (typeof location === 'undefined') return;
  if (roomCode !== null) {
    const wanted = `#/room/${roomCode}`;
    if (location.hash !== wanted) location.hash = wanted;
  } else if (location.hash.startsWith('#/room/')) {
    // replaceState avoids piling a history entry per visited room.
    history.replaceState(null, '', location.pathname + location.search);
  }
}

export function Router(): ReactNode {
  const client = useGameClient();
  const phase = useStore(client.store, derivePhase);
  const roomCode = useStore(client.store, (s) =>
    s.soloStarting ? null : (s.roomView?.roomCode ?? null),
  );

  useEffect(() => {
    syncHash(roomCode);
  }, [roomCode]);

  switch (phase) {
    case 'home':
      return <Home />;
    case 'lobby':
      return <Lobby />;
    case 'table':
      return <Table />;
    case 'gameEnd':
      return <GameEnd />;
  }
}
