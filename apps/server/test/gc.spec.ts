/**
 * Idle-room garbage collection (AC-3), driven with fake timers against the
 * transport-agnostic RoomStore: rooms idle >= 2h are swept every 5 minutes,
 * their sockets closed with a typed error; activity resets the clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@five-hundred/protocol';
import {
  GC_INTERVAL_MS,
  IDLE_ROOM_MS,
  RoomStore,
  type Room,
  type RoomClient,
} from '../src/rooms.js';

interface FakeClient extends RoomClient {
  sent: Envelope[];
  closed: boolean;
}

function fakeClient(): FakeClient {
  const client: FakeClient = {
    sent: [],
    closed: false,
    room: null,
    seat: null,
    name: null,
    send(envelope) {
      client.sent.push(envelope);
    },
    close() {
      client.closed = true;
    },
  };
  return client;
}

describe('idle room GC (AC-3)', () => {
  let store: RoomStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new RoomStore();
  });

  afterEach(() => {
    store.stopGc();
    vi.useRealTimers();
  });

  it('sweeps a room idle past the threshold, closing sockets with a typed error', () => {
    const host = fakeClient();
    const room = store.createRoom(host, 'Ann') as Room;
    expect(store.rooms.size).toBe(1);

    vi.advanceTimersByTime(IDLE_ROOM_MS - 1);
    store.sweep();
    expect(store.rooms.size).toBe(1);

    vi.advanceTimersByTime(1);
    store.sweep();
    expect(store.rooms.size).toBe(0);
    expect(store.rooms.has(room.code)).toBe(false);
    expect(host.closed).toBe(true);
    expect(host.room).toBeNull();
    const last = host.sent.at(-1)?.event;
    expect(last).toMatchObject({ t: 'error', code: 'badRoomCode' });
  });

  it('runs the sweep on a 5-minute interval once startGc is called', () => {
    const host = fakeClient();
    store.createRoom(host, 'Ann');
    store.startGc();

    vi.advanceTimersByTime(IDLE_ROOM_MS - GC_INTERVAL_MS);
    expect(store.rooms.size).toBe(1);

    // Next tick lands past the idle threshold.
    vi.advanceTimersByTime(GC_INTERVAL_MS);
    expect(store.rooms.size).toBe(0);
    expect(host.closed).toBe(true);
  });

  it('activity resets the idle clock', () => {
    const host = fakeClient();
    store.createRoom(host, 'Ann');

    vi.advanceTimersByTime(IDLE_ROOM_MS - 1000);
    store.sit(host, 0); // touches lastActivity
    vi.advanceTimersByTime(IDLE_ROOM_MS - 1000);
    store.sweep();
    expect(store.rooms.size).toBe(1);

    vi.advanceTimersByTime(1000);
    store.sweep();
    expect(store.rooms.size).toBe(0);
  });

  it('leaves active rooms alone', () => {
    const host = fakeClient();
    store.createRoom(host, 'Ann');
    vi.advanceTimersByTime(GC_INTERVAL_MS);
    store.sweep();
    expect(store.rooms.size).toBe(1);
    expect(host.closed).toBe(false);
  });
});
