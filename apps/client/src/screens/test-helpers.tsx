/**
 * Shared fixtures for the screen component specs: a store wired to a spy
 * `send`, server-event application wrapped in act(), and RoomView builders.
 * Not a spec itself (no .test. in the name).
 */

import { act } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import type {
  ClientCommand,
  Envelope,
  RoomSeatView,
  RoomView,
  SeatGameView,
  StateBearingEvent,
} from '@five-hundred/protocol';
import { createStore } from '../store.ts';
import { GameClientProvider, Router, type GameClientHandle } from './router.tsx';

export interface TestClient extends GameClientHandle {
  sent: ClientCommand[];
}

/**
 * Node 25 ships its own (non-functional without --localstorage-file)
 * `localStorage` global that shadows jsdom's, so specs install a Map-backed
 * shim. Returns the backing map for direct assertions.
 */
export function installFakeLocalStorage(): Map<string, string> {
  const map = new Map<string, string>();
  const fake = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
  };
  try {
    Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
  } catch {
    (globalThis as { localStorage?: unknown }).localStorage = fake;
  }
  return map;
}

/** Store + spy send, with the connection already open (buttons enabled). */
export function makeClient(): TestClient {
  const sent: ClientCommand[] = [];
  const store = createStore({
    send: (c) => {
      sent.push(c);
    },
    storage: null,
  });
  store.getState().setConnection('open');
  return {
    store,
    send: (c) => {
      sent.push(c);
      return true;
    },
    sent,
  };
}

export function renderApp(client: TestClient): RenderResult {
  return render(
    <GameClientProvider client={client}>
      <Router />
    </GameClientProvider>,
  );
}

export function applyEvent(client: TestClient, envelope: Envelope): void {
  act(() => {
    client.store.getState().applyServerEvent(envelope);
  });
}

export const env = (seq: number, event: StateBearingEvent): Envelope => ({ seq, event });

export function emptySeatView(seat: number): RoomSeatView {
  return { seat, occupant: 'empty', name: null, difficulty: 'medium', connected: true };
}

export function humanSeatView(seat: number, name: string, connected = true): RoomSeatView {
  return { seat, occupant: 'human', name, difficulty: null, connected };
}

export function botSeatView(
  seat: number,
  difficulty: 'easy' | 'medium' | 'hard' = 'medium',
): RoomSeatView {
  return { seat, occupant: 'bot', name: null, difficulty, connected: true };
}

export function roomViewFixture(overrides: Partial<RoomView> = {}): RoomView {
  return {
    roomCode: 'ABCDE',
    hostSeat: null,
    seats: [0, 1, 2, 3].map(emptySeatView),
    started: false,
    paused: false,
    ...overrides,
  };
}

/** Shallow RedactedView stand-in: only the fields the screens touch. */
export function gameViewFixture(seat: number, phase = 'PLAY'): SeatGameView {
  return { view: { seat, phase, hand: [1, 2, 3] } } as unknown as SeatGameView;
}
