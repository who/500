/**
 * leaveRoom (fh-vwh): detach without closing the socket, vacate pre-game,
 * self-convert mid-game, dispose when the last human leaves, and allow
 * createRoom on the same connection afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Envelope } from '@five-hundred/protocol';
import { RoomStore, type Room, type RoomClient } from '../src/rooms.js';
import {
  setupGame,
  startTestApp,
  stopTestApp,
  type TestApp,
} from './harness.js';

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

describe('RoomStore.leaveRoom', () => {
  it('vacates a pre-game seat and lets the same client create a new room', () => {
    const store = new RoomStore();
    const host = fakeClient();
    const first = store.createRoom(host, 'Ann') as Room;
    store.sit(host, 0);
    expect(first.seats[0]?.kind).toBe('human');

    store.leaveRoom(host);
    expect(host.room).toBeNull();
    expect(host.seat).toBeNull();
    expect(host.closed).toBe(false);
    expect(first.seats[0]?.kind).toBe('empty');
    expect(first.clients.has(host)).toBe(false);

    const second = store.createRoom(host, 'Ann');
    expect(second).not.toBeNull();
    expect(second?.code).not.toBe(first.code);
  });

  it('detaches a spectator without touching seated humans', () => {
    const store = new RoomStore();
    const host = fakeClient();
    const watcher = fakeClient();
    const room = store.createRoom(host, 'Ann') as Room;
    store.sit(host, 0);
    store.joinRoom(watcher, room.code, 'Cam');
    expect(watcher.room).toBe(room);
    expect(watcher.seat).toBeNull();

    store.leaveRoom(watcher);
    expect(watcher.room).toBeNull();
    expect(room.seats[0]?.kind).toBe('human');
    expect(room.clients.has(host)).toBe(true);
  });

  it('converts the leaving seated human to a Hard bot mid-game and unpauses', () => {
    const store = new RoomStore();
    const host = fakeClient();
    const guest = fakeClient();
    const room = store.createRoom(host, 'Ann') as Room;
    store.sit(host, 0);
    store.joinRoom(guest, room.code, 'Bob');
    store.sit(guest, 2);
    store.startGame(host);
    expect(room.game).not.toBeNull();

    store.leaveRoom(guest);
    expect(guest.room).toBeNull();
    expect(guest.closed).toBe(false);
    expect(room.seats[2]?.kind).toBe('bot');
    expect(room.seats[2]).toMatchObject({ kind: 'bot', difficulty: 'hard' });
    expect(room.seats[0]?.kind).toBe('human');
    expect(room.host).toBe(host);
  });

  it('transfers host to a remaining human when the host leaves mid-game', () => {
    const store = new RoomStore();
    const host = fakeClient();
    const guest = fakeClient();
    const room = store.createRoom(host, 'Ann') as Room;
    store.sit(host, 0);
    store.joinRoom(guest, room.code, 'Bob');
    store.sit(guest, 2);
    store.startGame(host);

    store.leaveRoom(host);
    expect(room.seats[0]?.kind).toBe('bot');
    expect(room.host).toBe(guest);
  });

  it('disposes the game when the last human leaves mid-game', () => {
    let disposed = 0;
    const store = new RoomStore({
      startGame: () => ({
        dispose: () => {
          disposed += 1;
        },
      }),
    });
    const host = fakeClient();
    const room = store.createRoom(host, 'Ann') as Room;
    store.sit(host, 0);
    store.startGame(host);

    store.leaveRoom(host);
    expect(disposed).toBe(1);
    expect(room.seats[0]?.kind).toBe('bot');
    expect(room.clients.size).toBe(0);
  });

  it('does not convert when this socket is not the seated client', () => {
    const store = new RoomStore();
    const host = fakeClient();
    const zombie = fakeClient();
    const room = store.createRoom(host, 'Ann') as Room;
    store.sit(host, 0);
    store.startGame(host);
    // A kicked tab still attached to the room but with no seat.
    room.clients.add(zombie);
    zombie.room = room;
    zombie.seat = null;

    store.leaveRoom(zombie);
    expect(room.seats[0]?.kind).toBe('human');
    expect(host.room).toBe(room);
  });
});

describe('leaveRoom over the wire', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });

  afterAll(async () => {
    await stopTestApp(t);
  });

  it('lets the same socket createRoom after leaving, and mid-game leave unpauses', async () => {
    const fx = await setupGame(t);
    fx.bob.send({ t: 'leaveRoom' });
    const deadline = Date.now() + 2000;
    while (fx.room.seats[2]?.kind !== 'bot' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fx.room.seats[2]?.kind).toBe('bot');
    expect(fx.room.seats[2]).toMatchObject({ kind: 'bot', difficulty: 'hard' });

    fx.bob.send({ t: 'createRoom', name: 'Bob' });
    let created = await fx.bob.nextRoomState();
    while (created.room.roomCode === fx.roomCode && Date.now() < deadline + 2000) {
      created = await fx.bob.nextRoomState();
    }
    expect(created.room.roomCode).not.toBe(fx.roomCode);
    expect(created.room.started).toBe(false);
  });
});
