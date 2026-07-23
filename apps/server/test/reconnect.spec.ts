/**
 * Session continuity over real WebSockets (reconnect leaf, AC-1..AC-3):
 * token reattach mid-trick resends a view identical to the pre-drop one at
 * the current seq baseline; while the acting human is disconnected the game
 * makes no progress and roomState carries paused/disconnected flags; the
 * host converts a disconnected seat to a bot which then acts, and the old
 * token is dead thereafter. AC-1/AC-2 run on the scripted harness app
 * (bots: null); AC-3 runs against a real zero-delay BotDriver so the
 * converted seat actually plays.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legalActions, toActSeat, type GameState } from '@five-hundred/engine';
import { createGameSession, isGameSession, resumeView, type GameSession } from '../src/game.js';
import { RoomStore, type Room } from '../src/rooms.js';
import { attachWs, type WsApp } from '../src/ws.js';
import {
  SEED,
  TestClient,
  commandFor,
  driveUntil,
  setupGame,
  startTestApp,
  stopTestApp,
  type TestApp,
} from './harness.js';

describe('token reattach and pause (scripted app)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });

  afterAll(async () => {
    await stopTestApp(t);
  });

  it('AC-1: drop + token reattach mid-trick resends the identical view with no progress', async () => {
    const fx = await setupGame(t);
    await driveUntil(fx, (s) => s.play !== null && s.play.plays.length >= 1);
    const preView = fx.bobView;
    const preState = fx.session.state;

    fx.bob.close();
    const dropped = await fx.ann.nextRoomState();
    expect(dropped.room.seats[2]?.connected).toBe(false);

    const bob2 = await TestClient.connect(t.port);
    bob2.send({ t: 'joinRoom', roomCode: fx.roomCode, name: 'Bob', token: fx.bobToken });
    const rejoined = await bob2.nextRoomState();
    expect(rejoined.room.seats[2]?.connected).toBe(true);

    const view = await bob2.next('gameView');
    expect(view.event.view.view).toEqual(preView);
    // Private resend at the current baseline: same seq as the roomState wave
    // it follows, because the drop + reattach advanced no game state.
    expect(view.seq).toBe(rejoined.seq);
    const request = await bob2.next('actionRequest');
    expect(request.seq).toBe(rejoined.seq);
    expect(fx.session.state).toBe(preState);
  }, 20000);

  it('AC-2: while the acting human is disconnected the game waits and roomState shows paused', async () => {
    const fx = await setupGame(t);
    await driveUntil(fx, (s) => s.play !== null && toActSeat(s) === 2);
    const preState = fx.session.state;

    fx.bob.close();
    const paused = await fx.ann.nextRoomState();
    expect(paused.room.seats[2]?.connected).toBe(false);
    expect(paused.room.paused).toBe(true);

    // Nobody else can act for the seat: Ann's attempt bounces off validation.
    const card = fx.annView.hand[0];
    if (card === undefined) throw new Error('Ann has no cards to misplay');
    fx.ann.send({ t: 'playCard', card });
    expect(await fx.ann.nextError()).toBe('notYourTurn');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fx.session.state).toBe(preState);

    // Reattach resumes: the resent actionRequest carries the seat's legal
    // actions, and playing one advances the game.
    const bob2 = await TestClient.connect(t.port);
    bob2.send({ t: 'joinRoom', roomCode: fx.roomCode, name: 'Bob', token: fx.bobToken });
    const rejoined = await bob2.nextRoomState();
    expect(rejoined.room.paused).toBe(false);
    const request = await bob2.next('actionRequest');
    expect(request.event.actions.length).toBeGreaterThan(0);
    const action = request.event.actions[0];
    if (action === undefined) throw new Error('no resumed action');
    bob2.send(commandFor(action));
    await bob2.next('gameView');
    expect(fx.session.state).not.toBe(preState);
  }, 20000);

  it('latest attach wins: a zombie socket on the seat is closed with a typed error', async () => {
    const fx = await setupGame(t);
    const bob2 = await TestClient.connect(t.port);
    bob2.send({ t: 'joinRoom', roomCode: fx.roomCode, name: 'Bob', token: fx.bobToken });
    expect(await fx.bob.nextError()).toBe('seatTaken');
    const rejoined = await bob2.nextRoomState();
    expect(rejoined.room.seats[2]?.connected).toBe(true);
    // The new socket controls the seat; the room still has exactly one Bob.
    expect([...fx.room.clients].filter((c) => c.seat === 2)).toHaveLength(1);
  }, 20000);

  it('rejects a reattach with a wrong token and with a dead room code', async () => {
    const fx = await setupGame(t);
    const stranger = await TestClient.connect(t.port);
    stranger.send({ t: 'joinRoom', roomCode: fx.roomCode, name: 'Eve', token: 'not-a-token' });
    expect(await stranger.nextError()).toBe('badToken');

    const late = await TestClient.connect(t.port);
    late.send({ t: 'joinRoom', roomCode: 'ZZZZZ', name: 'Bob', token: fx.bobToken });
    expect(await late.nextError()).toBe('badRoomCode');
  }, 20000);

  it('convertSeatToBot validation: host-only, disconnected human seats, never the host seat', async () => {
    const fx = await setupGame(t);
    fx.bob.send({ t: 'convertSeatToBot', seat: 0, difficulty: 'easy' });
    expect(await fx.bob.nextError()).toBe('notHost');

    fx.ann.send({ t: 'convertSeatToBot', seat: 0, difficulty: 'easy' });
    expect(await fx.ann.nextError()).toBe('badCommand'); // own (host) seat

    fx.ann.send({ t: 'convertSeatToBot', seat: 2, difficulty: 'easy' });
    expect(await fx.ann.nextError()).toBe('badCommand'); // still connected

    fx.ann.send({ t: 'convertSeatToBot', seat: 1, difficulty: 'easy' });
    expect(await fx.ann.nextError()).toBe('badCommand'); // already a bot
  }, 20000);
});

describe('seat-to-bot conversion with a live driver (AC-3)', () => {
  let server: Server;
  let app: WsApp;
  let port: number;

  beforeAll(async () => {
    server = createServer();
    const store = new RoomStore({
      // Seats default to Hard (fh-gpk); hardPool: null keeps their decisions
      // on the synchronous in-thread path so this suite stays fast and
      // deterministic — the pool routing itself is hardPool.spec.ts's job.
      startGame: (room) =>
        createGameSession(room, SEED, { bots: { delayMs: () => 0, hardPool: null } }),
      resumeView,
    });
    app = attachWs(server, store);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    app.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  async function until(cond: () => boolean, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error('condition never held');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /**
   * Drive a driver-powered game (bots act on their own) until seat 2 holds
   * the turn in play. Humans are scripted server-side from legalActions but
   * act over their sockets: Ann opens 7 Spades when offered, everyone else
   * passes/declines/plays the first legal action.
   */
  async function driveToBobsPlayTurn(
    room: Room,
    session: GameSession,
    ann: TestClient,
    bob: TestClient,
  ): Promise<void> {
    const humanTurnOrScored = (s: GameState): boolean => {
      const seat = toActSeat(s);
      return seat === 0 || seat === 2 || s.phase === 'handScored';
    };
    for (let guard = 0; guard < 300; guard++) {
      await until(() => humanTurnOrScored(session.state) || room.game === null);
      const state = session.state;
      if (state.phase === 'handScored') {
        ann.send({ t: 'nextHand' });
        bob.send({ t: 'nextHand' });
        await until(() => session.state !== state);
        continue;
      }
      const seat = toActSeat(state);
      if (seat !== 0 && seat !== 2) continue;
      if (state.phase === 'play' && seat === 2) return;
      const actions = legalActions(state, seat);
      let action =
        (state.phase === 'auction' && state.contract === null
          ? actions.find(
              (a) => a.type === 'bid' && a.bid.kind === 'NUM' && a.bid.level === 7 && a.bid.strain === 0 && seat === 0,
            )
          : undefined) ??
        actions.find((a) => a.type === 'bid' && a.bid.kind === 'PASS') ??
        actions.find((a) => a.type === 'declineSlam') ??
        actions[0];
      if (action === undefined) throw new Error(`seat ${seat} has no legal actions`);
      if (action.type === 'discardKeeps') {
        action = { type: 'discardKeeps', seat, keeps: (state.hands[seat] ?? []).slice(0, 10) };
      }
      (seat === 0 ? ann : bob).send(commandFor(action));
      await until(() => session.state !== state);
    }
    throw new Error('never reached a play-phase turn for seat 2');
  }

  it('AC-3: converting a dropped seat hands it to a bot that acts, and kills the old token', async () => {
    const ann = await TestClient.connect(port);
    ann.send({ t: 'createRoom', name: 'Ann' });
    const { room: created } = await ann.nextRoomState();
    const bob = await TestClient.connect(port);
    bob.send({ t: 'joinRoom', roomCode: created.roomCode, name: 'Bob' });
    await bob.nextRoomState();
    ann.send({ t: 'sit', seat: 0 });
    await ann.next('seatGranted');
    bob.send({ t: 'sit', seat: 2 });
    const bobToken = (await bob.next('seatGranted')).event.token;
    ann.send({ t: 'startGame' });
    await ann.next('gameView');

    const room = app.store.rooms.get(created.roomCode);
    if (room === undefined || !isGameSession(room.game)) throw new Error('game did not start');
    const session = room.game;

    await driveToBobsPlayTurn(room, session, ann, bob);
    const droppedState = session.state;

    bob.close();
    await until(() => {
      const s = room.seats[2];
      return s !== undefined && s.kind === 'human' && !s.connected;
    });

    ann.send({ t: 'convertSeatToBot', seat: 2, difficulty: 'easy' });
    // Everyone learns the seat is now a bot (and the game is unpaused)...
    for (;;) {
      const rs = await ann.nextRoomState();
      if (rs.room.seats[2]?.occupant === 'bot') {
        expect(rs.room.seats[2]?.difficulty).toBe('easy');
        expect(rs.room.paused).toBe(false);
        break;
      }
    }
    // ...and the bot takes the very turn the human abandoned.
    await until(() => session.state !== droppedState);

    // The invalidated token can never reclaim the seat.
    const ghost = await TestClient.connect(port);
    ghost.send({ t: 'joinRoom', roomCode: created.roomCode, name: 'Bob', token: bobToken });
    expect(await ghost.nextError()).toBe('badToken');
    ghost.close();
    ann.close();
  }, 30000);
});
