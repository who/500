/**
 * Shared game-loop test harness: a seeded server app, ws TestClients, and a
 * scripted driver that plays the opening of a game (auction won by seat 0 at
 * 7 Spades, slam declined, exchange, then tricks). Humans hold seats 0 (Ann)
 * and 2 (Bob) and act through real ws commands picked from their own
 * actionRequest payloads; bot seats 1 and 3 are driven through the exported
 * applyGameAction path with engine-derived stub actions (kept deterministic
 * on purpose; the real bot driver is covered by botDriver.spec.ts).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  toActSeat,
  type Action,
  type Card,
  type GameState,
  type RedactedView,
} from '@five-hundred/engine';
import { legalActions } from '@five-hundred/engine';
import type {
  ActionRequestEvent,
  ClientCommand,
  Envelope,
  ErrorCode,
  RoomView,
  ServerEvent,
} from '@five-hundred/protocol';
import {
  applyGameAction,
  createGameSession,
  isGameSession,
  resumeView,
  type GameSession,
} from '../src/game.js';
import { RoomStore, type Room } from '../src/rooms.js';
import { attachWs, type WsApp } from '../src/ws.js';

export const SEED = 0xc0ffee;

export interface TestApp {
  server: Server;
  app: WsApp;
  port: number;
}

/**
 * HTTP + ws app whose games always start from a fixed seed. Sessions run
 * without the bot driver (bots: null) so the scripted stubs below keep full
 * control of bot seats; botDriver.spec.ts exercises the driver itself.
 */
export async function startTestApp(seed: number = SEED): Promise<TestApp> {
  const server = createServer();
  const store = new RoomStore({
    startGame: (room) => createGameSession(room, seed, { bots: null }),
    resumeView,
  });
  const app = attachWs(server, store);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, app, port: (server.address() as AddressInfo).port };
}

export async function stopTestApp(t: TestApp): Promise<void> {
  t.app.close();
  await new Promise<void>((resolve) => {
    t.server.close(() => resolve());
  });
}

export class TestClient {
  private constructor(private readonly ws: WebSocket) {}

  readonly received: Envelope[] = [];
  private cursor = 0;
  private notify: (() => void) | null = null;

  static async connect(port: number): Promise<TestClient> {
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
    return client;
  }

  send(cmd: ClientCommand): void {
    this.ws.send(JSON.stringify(cmd));
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

  /** Every gameView payload received so far, in arrival order. */
  gameViews(): RedactedView[] {
    return this.received
      .filter((e) => e.event.t === 'gameView')
      .map((e) => (e.event as { view: { view: RedactedView } }).view.view);
  }

  /** Seq values of every seq-stamped envelope, in arrival order. */
  seqs(): number[] {
    return this.received.filter((e) => e.seq !== undefined).map((e) => e.seq as number);
  }

  close(): void {
    this.ws.close();
  }
}

export interface GameFixture {
  /** Seat 0, host, and the declarer in the scripted opening. */
  ann: TestClient;
  /** Seat 2. */
  bob: TestClient;
  /** In-room client that never sat (only when requested). */
  spectator: TestClient | null;
  room: Room;
  session: GameSession;
  roomCode: string;
  /** Seat tokens from seatGranted, for reconnect tests. */
  annToken: string;
  bobToken: string;
  /** Latest per-client view/actionRequest, refreshed by the driver. */
  annView: RedactedView;
  bobView: RedactedView;
  annReq: ActionRequestEvent;
  bobReq: ActionRequestEvent;
  /** Filled by the driver when Ann discards: her keeps and true discards. */
  keeps: Card[];
  discards: Card[];
}

/** Create a room with Ann seat 0, Bob seat 2, bot seats 1/3, game started. */
export async function setupGame(t: TestApp, opts: { spectator?: boolean } = {}): Promise<GameFixture> {
  const ann = await TestClient.connect(t.port);
  ann.send({ t: 'createRoom', name: 'Ann' });
  const { room: created } = await ann.nextRoomState();

  const bob = await TestClient.connect(t.port);
  bob.send({ t: 'joinRoom', roomCode: created.roomCode, name: 'Bob' });
  await bob.nextRoomState();

  let spectator: TestClient | null = null;
  if (opts.spectator === true) {
    spectator = await TestClient.connect(t.port);
    spectator.send({ t: 'joinRoom', roomCode: created.roomCode, name: 'Cam' });
    await spectator.nextRoomState();
  }

  ann.send({ t: 'sit', seat: 0 });
  const annToken = (await ann.next('seatGranted')).event.token;
  bob.send({ t: 'sit', seat: 2 });
  const bobToken = (await bob.next('seatGranted')).event.token;
  ann.send({ t: 'startGame' });

  const annView = (await ann.next('gameView')).event.view.view;
  const annReq = (await ann.next('actionRequest')).event;
  const bobView = (await bob.next('gameView')).event.view.view;
  const bobReq = (await bob.next('actionRequest')).event;

  const room = t.app.store.rooms.get(created.roomCode);
  if (room === undefined || !isGameSession(room.game)) throw new Error('game did not start');
  return {
    ann,
    bob,
    spectator,
    room,
    session: room.game,
    roomCode: created.roomCode,
    annToken,
    bobToken,
    annView,
    bobView,
    annReq,
    bobReq,
    keeps: [],
    discards: [],
  };
}

/** Apply one engine-derived stub action for the bot seat currently on turn. */
function botAct(fx: GameFixture): void {
  const state = fx.session.state;
  const seat = toActSeat(state);
  if (seat === null) throw new Error(`no actor to stub in phase ${state.phase}`);
  const actions = legalActions(state, seat);
  let action = actions.find((a) => a.type === 'bid' && a.bid.kind === 'PASS') ?? actions[0];
  if (action === undefined) throw new Error(`seat ${seat} has no legal actions`);
  if (action.type === 'discardKeeps') {
    action = { type: 'discardKeeps', seat, keeps: (state.hands[seat] ?? []).slice(0, 10) };
  }
  const result = applyGameAction(fx.room, action);
  if (!result.ok) throw new Error(`stub action rejected: ${result.error.message}`);
}

/** Protocol command equivalent of an engine action (seat comes from the socket). */
export function commandFor(action: Action, keeps?: readonly Card[]): ClientCommand {
  switch (action.type) {
    case 'bid':
      return { t: 'bid', bid: action.bid };
    case 'declareSlam':
      return { t: 'declareSlam' };
    case 'declineSlam':
      return { t: 'declineSlam' };
    case 'giveCard':
      return { t: 'giveCard', card: action.card };
    case 'discardKeeps':
      return { t: 'discardKeeps', keeps: keeps ?? action.keeps };
    case 'playCard':
      return action.jokerSuit === undefined
        ? { t: 'playCard', card: action.card }
        : { t: 'playCard', card: action.card, jokerSuit: action.jokerSuit };
    case 'nextHand':
      return { t: 'nextHand' };
  }
}

/** Run `act`, then absorb the resulting gameView + actionRequest wave. */
async function step(fx: GameFixture, act: () => void): Promise<void> {
  act();
  fx.annView = (await fx.ann.next('gameView')).event.view.view;
  fx.annReq = (await fx.ann.next('actionRequest')).event;
  fx.bobView = (await fx.bob.next('gameView')).event.view.view;
  fx.bobReq = (await fx.bob.next('actionRequest')).event;
}

/** Scripted choice for a human turn: 7S once from Ann, else pass/decline/first. */
function chooseHuman(fx: GameFixture, seat: number): ClientCommand {
  const req = seat === 0 ? fx.annReq : fx.bobReq;
  const view = seat === 0 ? fx.annView : fx.bobView;
  const state = fx.session.state;
  if (state.phase === 'auction') {
    const wanted =
      seat === 0 && state.contract === null && (state.auction?.ladderPos ?? -1) < 0
        ? req.actions.find(
            (a) => a.type === 'bid' && a.bid.kind === 'NUM' && a.bid.level === 7 && a.bid.strain === 0,
          )
        : req.actions.find((a) => a.type === 'bid' && a.bid.kind === 'PASS');
    if (wanted === undefined) throw new Error('scripted bid not offered');
    return commandFor(wanted);
  }
  if (state.phase === 'slamDecision') {
    const decline = req.actions.find((a) => a.type === 'declineSlam');
    if (decline === undefined) throw new Error('declineSlam not offered');
    return commandFor(decline);
  }
  if (state.phase === 'middleExchange') {
    const template = req.actions.find((a) => a.type === 'discardKeeps');
    if (template === undefined) throw new Error('discardKeeps not offered');
    const keeps = view.hand.slice(0, 10);
    fx.keeps = [...keeps];
    fx.discards = view.hand.filter((c) => !keeps.includes(c));
    return commandFor(template, keeps);
  }
  const first = req.actions[0];
  if (first === undefined) throw new Error(`seat ${seat} has no legal actions`);
  return commandFor(first);
}

/**
 * Drive the scripted game until `done(state)` holds: humans act over ws from
 * their actionRequests, bot seats through the server-side apply path, and
 * handScored is crossed by readying both humans.
 */
export async function driveUntil(
  fx: GameFixture,
  done: (state: GameState) => boolean,
): Promise<void> {
  for (let guard = 0; guard < 500; guard++) {
    const state = fx.session.state;
    if (done(state)) return;
    if (state.phase === 'handScored') {
      await step(fx, () => {
        fx.ann.send({ t: 'nextHand' });
        fx.bob.send({ t: 'nextHand' });
      });
      continue;
    }
    const seat = toActSeat(state);
    if (seat === null) throw new Error(`no actor in phase ${state.phase}`);
    if (seat === 0 || seat === 2) {
      const cmd = chooseHuman(fx, seat);
      await step(fx, () => (seat === 0 ? fx.ann : fx.bob).send(cmd));
    } else {
      await step(fx, () => botAct(fx));
    }
  }
  throw new Error('driveUntil never reached the target state');
}

/** Auction + exchange + the complete first trick (AC-1 / AC-3 segment). */
export async function driveOpeningTrick(fx: GameFixture): Promise<void> {
  await driveUntil(fx, (s) => s.play !== null && s.play.tricks.length >= 1);
}
