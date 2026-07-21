/**
 * Room lifecycle over real WebSockets (AC-1, AC-2): create/join/sit/
 * configureBots/startGame happy path with identical increasing-seq
 * broadcasts, plus seatTaken / notHost / badRoomCode / zero-human-start
 * rejections and pre-game host transfer.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ClientCommand, Envelope, ErrorCode, RoomView, ServerEvent } from '@five-hundred/protocol';
import { attachWs, type WsApp } from '../src/ws.js';

let server: Server;
let app: WsApp;
let port: number;
const openClients: TestClient[] = [];

class TestClient {
  private constructor(private readonly ws: WebSocket) {}

  readonly received: Envelope[] = [];
  private cursor = 0;
  private notify: (() => void) | null = null;

  static async connect(): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const client = new TestClient(ws);
    ws.addEventListener('message', (ev) => {
      client.received.push(JSON.parse(String(ev.data)) as Envelope);
      client.notify?.();
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('ws connect failed')));
    });
    openClients.push(client);
    return client;
  }

  send(cmd: ClientCommand): void {
    this.ws.send(JSON.stringify(cmd));
  }

  sendRaw(text: string): void {
    this.ws.send(text);
  }

  /** Next unconsumed envelope whose event has type `t` (waits up to 2s). */
  async next<T extends ServerEvent['t']>(
    t: T,
  ): Promise<Envelope & { event: Extract<ServerEvent, { t: T }> }> {
    const deadline = Date.now() + 2000;
    for (;;) {
      while (this.cursor < this.received.length) {
        const envelope = this.received[this.cursor++];
        if (envelope !== undefined && envelope.event.t === t) {
          return envelope as Envelope & { event: Extract<ServerEvent, { t: T }> };
        }
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${t}`);
      await new Promise<void>((resolve) => {
        this.notify = resolve;
        setTimeout(resolve, 25);
      });
      this.notify = null;
    }
  }

  async nextRoomState(): Promise<{ seq: number; room: RoomView }> {
    const env = await this.next('roomState');
    return { seq: env.seq as number, room: env.event.room };
  }

  async nextError(): Promise<ErrorCode> {
    return (await this.next('error')).event.code;
  }

  close(): void {
    this.ws.close();
  }
}

beforeAll(async () => {
  server = createServer();
  app = attachWs(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(() => {
  for (const c of openClients.splice(0)) c.close();
});

afterAll(async () => {
  app.close();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

async function createRoomAs(name: string): Promise<{ client: TestClient; room: RoomView }> {
  const client = await TestClient.connect();
  client.send({ t: 'createRoom', name });
  const { room } = await client.nextRoomState();
  return { client, room };
}

describe('room lifecycle happy path (AC-1)', () => {
  it('two clients create + join + sit + start and see identical increasing-seq roomState', async () => {
    const { client: ann, room: created } = await createRoomAs('Ann');
    expect(created.roomCode).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    expect(created.hostSeat).toBeNull();
    expect(created.started).toBe(false);

    const bob = await TestClient.connect();
    bob.send({ t: 'joinRoom', roomCode: created.roomCode, name: 'Bob' });
    const [annJoin, bobJoin] = [await ann.nextRoomState(), await bob.nextRoomState()];
    expect(annJoin).toEqual(bobJoin);
    expect(annJoin.seq).toBeGreaterThan(0);

    ann.send({ t: 'sit', seat: 0 });
    const annGrant = await ann.next('seatGranted');
    expect(annGrant.event.seat).toBe(0);
    expect(annGrant.event.token).toMatch(/^[0-9a-f-]{36}$/);
    const [annSit, bobSit] = [await ann.nextRoomState(), await bob.nextRoomState()];
    expect(annSit).toEqual(bobSit);
    expect(annSit.room.hostSeat).toBe(0);
    expect(annSit.room.seats[0]).toMatchObject({ occupant: 'human', name: 'Ann', connected: true });

    bob.send({ t: 'sit', seat: 2 });
    const bobGrant = await bob.next('seatGranted');
    expect(bobGrant.event.seat).toBe(2);
    expect(bobGrant.event.token).not.toBe(annGrant.event.token);
    const [annSit2, bobSit2] = [await ann.nextRoomState(), await bob.nextRoomState()];
    expect(annSit2).toEqual(bobSit2);

    // Tokens stay private to the socket that sat.
    expect(ann.received.filter((e) => e.event.t === 'seatGranted')).toHaveLength(1);
    expect(bob.received.filter((e) => e.event.t === 'seatGranted')).toHaveLength(1);

    ann.send({ t: 'configureBots', bots: [{ seat: 1, difficulty: 'hard' }] });
    const [annCfg, bobCfg] = [await ann.nextRoomState(), await bob.nextRoomState()];
    expect(annCfg).toEqual(bobCfg);
    expect(annCfg.room.seats[1]).toMatchObject({ occupant: 'empty', difficulty: 'hard' });

    ann.send({ t: 'startGame' });
    const [annStart, bobStart] = [await ann.nextRoomState(), await bob.nextRoomState()];
    expect(annStart).toEqual(bobStart);
    expect(annStart.room.started).toBe(true);
    expect(annStart.room.seats[1]).toMatchObject({ occupant: 'bot', difficulty: 'hard' });
    expect(annStart.room.seats[3]).toMatchObject({ occupant: 'bot', difficulty: 'medium' });

    // Both clients saw the same strictly increasing per-room seq sequence
    // (Ann has one extra roomState from before Bob joined).
    const seqs = (c: TestClient) =>
      c.received.filter((e) => e.event.t === 'roomState').map((e) => e.seq as number);
    expect(seqs(ann).slice(1)).toEqual(seqs(bob));
    for (const c of [ann, bob]) {
      const s = seqs(c);
      for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThan(s[i - 1] as number);
    }
  });
});

describe('rejections (AC-2)', () => {
  it('rejects sitting in an occupied seat with seatTaken', async () => {
    const { client: ann, room } = await createRoomAs('Ann');
    ann.send({ t: 'sit', seat: 1 });
    await ann.nextRoomState();

    const bob = await TestClient.connect();
    bob.send({ t: 'joinRoom', roomCode: room.roomCode, name: 'Bob' });
    await bob.nextRoomState();
    bob.send({ t: 'sit', seat: 1 });
    expect(await bob.nextError()).toBe('seatTaken');
  });

  it('rejects configureBots and startGame from a non-host with notHost', async () => {
    const { room } = await createRoomAs('Ann');
    const bob = await TestClient.connect();
    bob.send({ t: 'joinRoom', roomCode: room.roomCode, name: 'Bob' });
    await bob.nextRoomState();

    bob.send({ t: 'configureBots', bots: [{ seat: 3, difficulty: 'easy' }] });
    expect(await bob.nextError()).toBe('notHost');
    bob.send({ t: 'startGame' });
    expect(await bob.nextError()).toBe('notHost');
  });

  it('rejects joining an unknown room with badRoomCode', async () => {
    const carol = await TestClient.connect();
    carol.send({ t: 'joinRoom', roomCode: 'ZZZZZ', name: 'Carol' });
    expect(await carol.nextError()).toBe('badRoomCode');
  });

  it('rejects startGame before any human has sat', async () => {
    const { client: ann } = await createRoomAs('Ann');
    ann.send({ t: 'startGame' });
    expect(await ann.nextError()).toBe('badCommand');
  });

  it('rejects malformed JSON and unknown commands with badCommand', async () => {
    const carol = await TestClient.connect();
    carol.sendRaw('not json');
    expect(await carol.nextError()).toBe('badCommand');
    carol.sendRaw(JSON.stringify({ t: 'noSuchCommand' }));
    expect(await carol.nextError()).toBe('badCommand');
  });

  it('rejects game commands before the game starts', async () => {
    const { client: ann } = await createRoomAs('Ann');
    ann.send({ t: 'nextHand' });
    expect(await ann.nextError()).toBe('badCommand');
  });
});

describe('host transfer', () => {
  it('moves host to the next human when the host leaves pre-game', async () => {
    const { client: ann, room } = await createRoomAs('Ann');
    const bob = await TestClient.connect();
    bob.send({ t: 'joinRoom', roomCode: room.roomCode, name: 'Bob' });
    await bob.nextRoomState();
    bob.send({ t: 'sit', seat: 3 });
    await bob.nextRoomState();

    ann.close();
    const { room: after } = await bob.nextRoomState();
    expect(after.hostSeat).toBe(3);

    bob.send({ t: 'startGame' });
    const { room: started } = await bob.nextRoomState();
    expect(started.started).toBe(true);
  });
});
