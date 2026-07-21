/**
 * Milestone M4 gate (PRD section 7.4): simulated multi-client games over real
 * WebSockets. Four scenarios:
 *   1. A full game — 2 humans + 2 bots — driven to gameOver by scripted
 *      clients that act only on legal actions from their own actionRequest
 *      payloads (AC-1).
 *   2. Universal redaction: every outbound message of every scenario passes a
 *      generic inspector that knows each seat's true hand from an omniscient
 *      side channel and flags any foreign card id (AC-2).
 *   3. Seeded fuzz: 500 random/malformed/out-of-turn commands, all rejected
 *      with typed errors, seq never advancing on rejection (AC-3); plus a
 *      client flooding commands inside a bot pacing window.
 *   4. The reconnect leaf at full-game scale: a client drops and reattaches
 *      repeatedly (both mid-turn and mid-broadcast) through an entire game.
 *
 * The omniscient side channel is test-side only: each room's client set is
 * wrapped in-process so every send records the unredacted GameState at the
 * instant of transmission. Nothing is compiled into production paths — the
 * tap exists only inside this suite. Ephemeral ports throughout.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cardName,
  legalActions,
  makeRng,
  newGame,
  redactedView,
  toActSeat,
  type Action,
  type Card,
  type GameState,
  type RedactedView,
  type Rng,
} from '@five-hundred/engine';
import {
  ERROR_CODES,
  isEnvelope,
  type Envelope,
  type ErrorCode,
  type GameOverEvent,
  type ServerEvent,
} from '@five-hundred/protocol';
import { applyGameAction, createGameSession, isGameSession, resumeView } from '../src/game.js';
import { RoomStore, type Room, type RoomClient } from '../src/rooms.js';
import { attachWs, type WsApp } from '../src/ws.js';
import {
  SEED,
  TestClient,
  commandFor,
  driveUntil,
  setupGame,
  startTestApp,
  stopTestApp,
} from './harness.js';

/** Seeds for the driver-powered full games; fixed so failures reproduce. */
const GAME_SEED = 0x500cafe;
const RECONNECT_SEED = 0x5eed;
const FUZZ_SEED = 0xf022ba11;

// ---------------------------------------------------------------------------
// Omniscient send tap (scenario 2's side channel)
// ---------------------------------------------------------------------------

interface SentRecord {
  /** The receiving client's seat at send time (null = spectator/lobby). */
  seat: number | null;
  envelope: Envelope;
  /**
   * Unredacted state at the instant of send. Null only for the opening wave,
   * which createGameSession broadcasts before startGame assigns room.game —
   * that state is exactly newGame(seed), which the inspector substitutes.
   */
  state: GameState | null;
}

/** Wrap every present and future client of the room so sends are recorded. */
function tapRoom(room: Room, records: SentRecord[]): void {
  const wrap = (client: RoomClient): void => {
    const original = client.send.bind(client);
    client.send = (envelope: Envelope): void => {
      const game = room.game;
      records.push({ seat: client.seat, envelope, state: isGameSession(game) ? game.state : null });
      original(envelope);
    };
  };
  class TappedSet extends Set<RoomClient> {
    override add(client: RoomClient): this {
      if (!this.has(client)) wrap(client);
      return super.add(client);
    }
  }
  const tapped = new TappedSet();
  for (const client of room.clients) tapped.add(client);
  room.clients = tapped;
}

/** Tap every room the store creates, before any game traffic can flow. */
function tapStore(store: RoomStore, records: SentRecord[]): void {
  const original = store.createRoom.bind(store);
  store.createRoom = (client: RoomClient, name: string): Room | null => {
    const room = original(client, name);
    if (room !== null) tapRoom(room, records);
    return room;
  };
}

// ---------------------------------------------------------------------------
// Redaction inspector (AC-2)
// ---------------------------------------------------------------------------

/** Card ids at positions only the receiving seat may legitimately see. */
function privateCards(event: ServerEvent): Card[] {
  const cards: Card[] = [];
  if (event.t === 'gameView') cards.push(...event.view.view.hand);
  if (event.t === 'actionRequest') {
    for (const action of event.actions) {
      if (action.type === 'giveCard' || action.type === 'playCard') cards.push(action.card);
      if (action.type === 'discardKeeps') cards.push(...action.keeps);
    }
  }
  return cards;
}

/** Card ids on public trick surfaces (legitimate once actually played). */
function publicCards(event: ServerEvent): Card[] {
  const cards: Card[] = [];
  if (event.t === 'gameView') {
    const view = event.view.view;
    for (const play of view.trick?.plays ?? []) cards.push(play.card);
    for (const play of view.lastTrick?.plays ?? []) cards.push(play.card);
  }
  if (event.t === 'trickResolved') {
    for (const play of event.trick.plays) cards.push(play.card);
  }
  return cards;
}

/** Every card that has hit the table in this hand, per the true state. */
function playedCards(state: GameState): Set<Card> {
  const played = new Set<Card>();
  for (const trick of state.play?.tricks ?? []) {
    for (const play of trick.plays) played.add(play.card);
  }
  for (const play of state.play?.plays ?? []) played.add(play.card);
  return played;
}

/**
 * The assertion-by-construction inspector: every record's payload must pass
 * the protocol envelope guard, every private-position card must be in the
 * receiving seat's true hand at send time, and every public-position card
 * must actually have been played. Returns human-readable violations; any hit
 * is a critical engine/server defect (do not weaken this).
 */
function inspect(records: readonly SentRecord[], seed: number): string[] {
  const opening = newGame(seed);
  const problems: string[] = [];
  records.forEach((record, i) => {
    if (!isEnvelope(record.envelope)) {
      problems.push(`record ${i}: envelope fails the protocol guard`);
      return;
    }
    const event = record.envelope.event;
    const priv = privateCards(event);
    const pub = publicCards(event);
    if (priv.length === 0 && pub.length === 0) return;
    const state = record.state ?? opening;
    const own = new Set(record.seat !== null ? (state.hands[record.seat] ?? []) : []);
    for (const card of priv) {
      if (!own.has(card)) {
        problems.push(`record ${i}: foreign card ${cardName(card)} in ${event.t} to seat ${String(record.seat)}`);
      }
    }
    const played = playedCards(state);
    for (const card of pub) {
      if (!played.has(card)) {
        problems.push(`record ${i}: unplayed card ${cardName(card)} on a trick surface of ${event.t} to seat ${String(record.seat)}`);
      }
    }
  });
  return problems;
}

describe('redaction inspector self-test', () => {
  it('flags planted foreign cards, unplayed trick cards, and unguarded envelopes', () => {
    const state = newGame(SEED);
    const foreign = state.hands[1]?.[0];
    if (foreign === undefined) throw new Error('no card to plant');
    const leakyView = { ...redactedView(state, 0), hand: [...(state.hands[0] ?? []), foreign] };
    const records: SentRecord[] = [
      { seat: 0, state, envelope: { seq: 0, event: { t: 'gameView', view: { view: leakyView } } } },
      {
        seat: 2,
        state,
        envelope: {
          seq: 1,
          event: {
            t: 'trickResolved',
            trick: { leader: 0, ledSuit: 0, winner: 0, plays: [{ seat: 0, card: foreign }] },
          },
        },
      },
      { seat: 0, state, envelope: { seq: 2, event: { t: 'bogus' } } as unknown as Envelope },
    ];
    const problems = inspect(records, SEED);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('foreign card');
    expect(problems[1]).toContain('unplayed card');
    expect(problems[2]).toContain('fails the protocol guard');
  });
});

// ---------------------------------------------------------------------------
// Wire-driven scripted player (scenario 1)
// ---------------------------------------------------------------------------

/**
 * Seeded choice among the offered legal actions; keeps come from the view.
 * Biased toward PASS and declineSlam — unbiased random bidding fails huge
 * contracts and ends games in one hand, and the suite wants games that cross
 * multiple handScored -> nextHand cycles.
 */
function chooseAction(actions: readonly Action[], latestHand: readonly Card[], rng: Rng) {
  const pass = actions.find((a) => a.type === 'bid' && a.bid.kind === 'PASS');
  if (pass !== undefined && rng.int(4) > 0) return commandFor(pass);
  const decline = actions.find((a) => a.type === 'declineSlam');
  if (decline !== undefined && rng.int(6) > 0) return commandFor(decline);
  const action = actions[rng.int(actions.length)];
  if (action === undefined) throw new Error('no action offered to choose from');
  if (action.type === 'discardKeeps') {
    if (latestHand.length < 10) throw new Error(`cannot keep 10 of ${latestHand.length} cards`);
    const hand = [...latestHand];
    rng.shuffle(hand);
    return commandFor(action, hand.slice(0, 10).sort((a, b) => a - b));
  }
  return commandFor(action);
}

/** The game is over for this client once it saw gameOver (or a terminal view). */
function gameFinished(client: TestClient): boolean {
  if (client.received.some((e) => e.event.t === 'gameOver')) return true;
  return client.gameViews().at(-1)?.phase === 'gameOver';
}

/**
 * Play a seat purely from the wire: consume actionRequests in order, act on
 * every non-empty one with a seeded-random legal action. The server sends a
 * final (empty) actionRequest wave after gameOver, so the loop never blocks
 * at game end.
 */
async function playSeat(client: TestClient, rngSeed: number): Promise<void> {
  const rng = makeRng(rngSeed);
  for (let guard = 0; guard < 5000; guard++) {
    if (gameFinished(client)) return;
    const request = await client.next('actionRequest');
    const actions = request.event.actions;
    if (actions.length === 0) continue;
    const hand = client.gameViews().at(-1)?.hand ?? [];
    client.send(chooseAction(actions, hand, rng));
  }
  throw new Error('player never saw gameOver');
}

/** Per-client wire hygiene: guarded envelopes, gap-free seqs, seq-less errors. */
function expectCleanStream(client: TestClient, opts: { allowResumeDuplicates?: boolean } = {}): void {
  for (const envelope of client.received) {
    expect(isEnvelope(envelope)).toBe(true);
    if (envelope.event.t === 'error') expect(envelope.seq).toBeUndefined();
  }
  const seqs = client.seqs();
  for (let i = 1; i < seqs.length; i++) {
    const step = (seqs[i] ?? 0) - (seqs[i - 1] ?? 0);
    if (opts.allowResumeDuplicates === true) {
      // A resumed connection re-baselines at the last consumed seq.
      expect([0, 1]).toContain(step);
    } else {
      expect(step).toBe(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Driver-powered test app (real BotDriver, configurable pacing)
// ---------------------------------------------------------------------------

interface DriverApp {
  server: Server;
  app: WsApp;
  store: RoomStore;
  port: number;
  records: SentRecord[];
}

async function startDriverApp(seed: number, delayMs: number): Promise<DriverApp> {
  const server = createServer();
  const store = new RoomStore({
    startGame: (room) => createGameSession(room, seed, { bots: { delayMs: () => delayMs } }),
    resumeView,
  });
  const records: SentRecord[] = [];
  tapStore(store, records);
  const app = attachWs(server, store);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, app, store, port: (server.address() as AddressInfo).port, records };
}

async function stopDriverApp(d: DriverApp): Promise<void> {
  d.app.close();
  await new Promise<void>((resolve) => {
    d.server.close(() => resolve());
  });
}

/** Room with Ann seat 0 (host) + Bob seat 2, bots configured, game started. */
async function startDriverGame(d: DriverApp): Promise<{
  ann: TestClient;
  bob: TestClient;
  room: Room;
  roomCode: string;
  bobToken: string;
}> {
  const ann = await TestClient.connect(d.port);
  ann.send({ t: 'createRoom', name: 'Ann' });
  const { room: created } = await ann.nextRoomState();
  const bob = await TestClient.connect(d.port);
  bob.send({ t: 'joinRoom', roomCode: created.roomCode, name: 'Bob' });
  await bob.nextRoomState();
  ann.send({ t: 'sit', seat: 0 });
  await ann.next('seatGranted');
  bob.send({ t: 'sit', seat: 2 });
  const bobToken = (await bob.next('seatGranted')).event.token;
  ann.send({
    t: 'configureBots',
    bots: [
      { seat: 1, difficulty: 'easy' },
      { seat: 3, difficulty: 'medium' },
    ],
  });
  await ann.nextRoomState();
  ann.send({ t: 'startGame' });
  await ann.next('gameView');
  const room = d.store.rooms.get(created.roomCode);
  if (room === undefined || !isGameSession(room.game)) throw new Error('game did not start');
  return { ann, bob, room, roomCode: created.roomCode, bobToken };
}

const openClients: TestClient[] = [];

function track<T extends TestClient>(client: T): T {
  openClients.push(client);
  return client;
}

afterEach(() => {
  for (const client of openClients.splice(0)) client.close();
});

// ---------------------------------------------------------------------------
// Scenario 1 + 2: scripted full game, inspected end to end
// ---------------------------------------------------------------------------

describe('full game over real sockets (AC-1, AC-2)', () => {
  it('2 humans + 2 driver bots play a whole game to gameOver with zero foreign card ids', async () => {
    const d = await startDriverApp(GAME_SEED, 0);
    try {
      const { ann, bob, room } = await startDriverGame(d);
      track(ann);
      track(bob);
      await Promise.all([playSeat(ann, GAME_SEED ^ 0xa), playSeat(bob, GAME_SEED ^ 0xb)]);

      // AC-1: the game genuinely completed on the server and over the wire.
      if (!isGameSession(room.game)) throw new Error('session vanished');
      const state = room.game.state;
      expect(state.phase).toBe('gameOver');
      expect(state.game.winner === 0 || state.game.winner === 1).toBe(true);
      expect(state.handResult).not.toBeNull();
      // A real multi-hand game: at least one handScored -> nextHand ready-up
      // cycle crossed over the wire.
      expect(state.handNumber).toBeGreaterThanOrEqual(1);
      for (const client of [ann, bob]) {
        const over = client.received.find((e) => e.event.t === 'gameOver');
        if (over === undefined) throw new Error('client never received gameOver');
        const event = over.event as GameOverEvent;
        expect(event.winner).toBe(state.game.winner);
        expect(event.scores).toEqual(state.game.scores);
      }

      // Wire hygiene: legal scripted play produces zero rejections, every
      // envelope passes the guards, and each client's seq stream is gap-free.
      for (const client of [ann, bob]) {
        expect(client.received.some((e) => e.event.t === 'error')).toBe(false);
        expectCleanStream(client);
      }

      // AC-2: the omniscient inspector saw every outbound message.
      expect(d.records.length).toBeGreaterThan(200);
      expect(inspect(d.records, GAME_SEED)).toEqual([]);
    } finally {
      await stopDriverApp(d);
    }
  }, 120000);
});

// ---------------------------------------------------------------------------
// Scenario 3: seeded fuzz rejection (AC-3)
// ---------------------------------------------------------------------------

/** Junk frames: not JSON, truncated JSON, or JSON that is not a command. */
const RAW_CORPUS: readonly string[] = [
  '',
  'hello',
  '{"t":"bid"',
  '{"t":"requestState"',
  '[1,2,3]',
  'null',
  '123',
  'true',
  '{}',
  '{"t":42}',
  '"playCard"',
  '{"seq":1}',
  ' ￿',
];

/**
 * One seeded fuzz frame. Every case is guaranteed rejected at the frozen
 * point (play phase, a bot seat on turn, sender never the actor): malformed
 * frames die at the guards, well-formed game commands die in validation, and
 * lifecycle commands die on room state (started / not host / bad seat).
 */
function fuzzMessage(rng: Rng): string {
  switch (rng.int(9)) {
    case 0:
      return RAW_CORPUS[rng.int(RAW_CORPUS.length)] ?? '';
    case 1: {
      const kind = rng.int(2) === 0 ? 'NUM' : 'PASS';
      return JSON.stringify({ t: 'bid', bid: { kind, level: 6 + rng.int(3), strain: rng.int(5) } });
    }
    case 2: {
      const cmd: Record<string, unknown> = { t: 'playCard', card: rng.int(60) };
      if (rng.int(2) === 0) cmd['jokerSuit'] = rng.int(4);
      return JSON.stringify(cmd);
    }
    case 3:
      return JSON.stringify({ t: ['declareSlam', 'declineSlam', 'nextHand'][rng.int(3)] });
    case 4:
      return JSON.stringify({ t: 'giveCard', card: rng.int(45) });
    case 5:
      return JSON.stringify({
        t: 'discardKeeps',
        keeps: Array.from({ length: rng.int(12) }, () => rng.int(45)),
      });
    case 6: {
      const lifecycle = [
        { t: 'sit', seat: rng.int(8) },
        { t: 'createRoom', name: 'Zed' },
        { t: 'joinRoom', roomCode: 'ZZZZZ', name: 'Eve', token: 'junk-token' },
        { t: 'startGame' },
      ];
      return JSON.stringify(lifecycle[rng.int(lifecycle.length)]);
    }
    case 7:
      return rng.int(2) === 0
        ? JSON.stringify({ t: 'convertSeatToBot', seat: rng.int(4), difficulty: 'easy' })
        : JSON.stringify({ t: 'configureBots', bots: [{ seat: rng.int(4), difficulty: 'easy' }] });
    default:
      return JSON.stringify({ t: `zzz-${String(rng.int(1000))}`, x: rng.random() });
  }
}

describe('seeded fuzz rejection (AC-3)', () => {
  it('500 fuzz commands: all rejected with typed errors, seq and state never advance', async () => {
    const records: SentRecord[] = [];
    const t = await startTestApp();
    tapStore(t.app.store, records);
    try {
      const fx = await setupGame(t, { spectator: true });
      track(fx.ann);
      track(fx.bob);
      if (fx.spectator === null) throw new Error('spectator missing');
      track(fx.spectator);
      // Freeze at a play-phase point where a (stub) bot seat holds the turn:
      // no sender can ever produce a legal command from here.
      await driveUntil(fx, (s) => s.phase === 'play' && toActSeat(s) !== 0 && toActSeat(s) !== 2);
      const frozen = fx.session.state;
      const seqBefore = fx.room.seq;
      const senders = [fx.ann, fx.bob, fx.spectator];
      const stampedBefore = senders.map((c) => c.seqs().length);

      const rng = makeRng(FUZZ_SEED);
      const tally = new Map<ErrorCode, number>();
      for (let i = 0; i < 500; i++) {
        const sender = senders[rng.int(senders.length)];
        if (sender === undefined) throw new Error('no sender');
        sender.sendRaw(fuzzMessage(rng));
        const code = await sender.nextError();
        expect(ERROR_CODES).toContain(code);
        tally.set(code, (tally.get(code) ?? 0) + 1);
      }

      // All 500 rejected, across every rejection layer.
      expect([...tally.values()].reduce((a, b) => a + b, 0)).toBe(500);
      for (const code of ['badCommand', 'notYourTurn', 'illegalAction', 'badToken', 'notHost'] as const) {
        expect(tally.get(code) ?? 0).toBeGreaterThan(0);
      }

      // Nothing moved: same state object, same room seq, zero seq-stamped
      // envelopes delivered to anyone during the fuzz, errors all seq-less.
      expect(fx.session.state).toBe(frozen);
      expect(fx.room.seq).toBe(seqBefore);
      senders.forEach((client, i) => expect(client.seqs().length).toBe(stampedBefore[i]));

      // The game is still alive: the frozen bot seat's action applies and
      // consumes exactly its own gameView + actionRequest waves.
      const seat = toActSeat(fx.session.state);
      if (seat === null) throw new Error('no frozen actor');
      const action = legalActions(fx.session.state, seat)[0];
      if (action === undefined) throw new Error('frozen actor has no legal action');
      const result = applyGameAction(fx.room, action);
      expect(result.ok).toBe(true);
      expect(fx.room.seq).toBe(seqBefore + 2);
      await fx.ann.next('gameView');
      await fx.bob.next('gameView');
      for (const client of [fx.ann, fx.bob]) expectCleanStream(client);

      // AC-2 holds across the fuzz traffic too.
      expect(inspect(records, SEED)).toEqual([]);
    } finally {
      await stopTestApp(t);
    }
  }, 60000);

  it('flooding commands during a bot pacing window rejects everything and never disturbs the bot', async () => {
    const d = await startDriverApp(GAME_SEED, 60);
    try {
      const { ann, bob, room } = await startDriverGame(d);
      track(ann);
      track(bob);
      // Opening auction starts on Ann (seat 0). She passes; the turn lands on
      // bot seat 1, which now sits in its 60ms pacing delay.
      const opening = await ann.next('actionRequest');
      const pass = opening.event.actions.find((a) => a.type === 'bid' && a.bid.kind === 'PASS');
      if (pass === undefined) throw new Error('PASS not offered');
      const seqBefore = room.seq;
      ann.send(commandFor(pass));

      // Flood the window: Ann re-bids (never her turn again here), Bob sends
      // phase-illegal commands (rejected whether or not his turn has come).
      for (let i = 0; i < 20; i++) {
        ann.send({ t: 'bid', bid: { kind: 'NUM', level: 7, strain: i % 5 } });
        bob.send(i % 2 === 0 ? { t: 'playCard', card: i } : { t: 'nextHand' });
      }
      for (let i = 0; i < 20; i++) {
        expect(await ann.nextError()).toBe('notYourTurn');
        expect(await bob.nextError()).toBe('illegalAction');
      }

      // The bot still takes its turn cleanly and play reaches Bob (seat 2).
      for (let guard = 0; guard < 10; guard++) {
        const request = await bob.next('actionRequest');
        if (request.event.actions.length > 0) break;
      }
      if (!isGameSession(room.game)) throw new Error('session vanished');
      expect(room.game.state.phase).toBe('auction');
      expect(toActSeat(room.game.state)).toBe(2);
      // Exactly two advances happened (Ann's pass, the bot's bid): the flood
      // burned no seq.
      expect(room.seq).toBe(seqBefore + 4);
      for (const client of [ann, bob]) expectCleanStream(client);
      expect(inspect(d.records, GAME_SEED)).toEqual([]);
    } finally {
      await stopDriverApp(d);
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// Scenario 4: reconnect at full-game scale
// ---------------------------------------------------------------------------

describe('reconnect at full-game scale (AC-1, AC-2)', () => {
  it('Bob drops and reattaches throughout an entire game, which still completes', async () => {
    const d = await startDriverApp(RECONNECT_SEED, 0);
    try {
      const game = await startDriverGame(d);
      const { ann, room, roomCode, bobToken } = game;
      track(ann);
      let bob = track(game.bob);
      if (!isGameSession(room.game)) throw new Error('game did not start');
      const session = room.game;

      const reattach = async (): Promise<TestClient> => {
        const fresh = track(await TestClient.connect(d.port));
        fresh.send({ t: 'joinRoom', roomCode, name: 'Bob', token: bobToken });
        const rejoined = await fresh.nextRoomState();
        expect(rejoined.room.seats[2]?.connected).toBe(true);
        return fresh;
      };

      let reconnects = 0;
      const bobLoop = async (): Promise<void> => {
        const rng = makeRng(RECONNECT_SEED ^ 0xb);
        let turns = 0;
        for (let guard = 0; guard < 5000; guard++) {
          if (gameFinished(bob)) return;
          const request = await bob.next('actionRequest');
          const actions = request.event.actions;
          if (actions.length === 0) continue;
          turns++;
          if (turns % 4 === 2) {
            // Drop before acting: it is Bob's turn, so the game pauses and
            // the reattached socket must resume the identical frozen view
            // plus a live actionRequest (the reconnect leaf, mid-game).
            bob.close();
            bob = await reattach();
            reconnects++;
            const resumed = await bob.next('gameView');
            expect(resumed.event.view.view).toEqual(redactedView(session.state, 2));
            const rerequest = await bob.next('actionRequest');
            expect(rerequest.event.actions.length).toBeGreaterThan(0);
            const hand = resumed.event.view.view.hand;
            bob.send(chooseAction(rerequest.event.actions, hand, rng));
          } else if (turns % 4 === 0) {
            // Drop right after acting: the resulting broadcast wave lands on
            // a closing socket, which must not disturb the room loop.
            const hand = bob.gameViews().at(-1)?.hand ?? [];
            bob.send(chooseAction(actions, hand, rng));
            bob.close();
            bob = await reattach();
            reconnects++;
            await bob.next('gameView');
          } else {
            const hand = bob.gameViews().at(-1)?.hand ?? [];
            bob.send(chooseAction(actions, hand, rng));
          }
        }
        throw new Error('Bob never saw the game end');
      };

      await Promise.all([playSeat(ann, RECONNECT_SEED ^ 0xa), bobLoop()]);

      expect(reconnects).toBeGreaterThanOrEqual(2);
      expect(session.state.phase).toBe('gameOver');
      expect(session.state.handNumber).toBeGreaterThanOrEqual(1);
      const over = ann.received.find((e) => e.event.t === 'gameOver');
      if (over === undefined) throw new Error('Ann never received gameOver');
      expect((over.event as GameOverEvent).winner).toBe(session.state.game.winner);

      // requestState still answers with the terminal view at the current
      // seq baseline, on the (possibly reattached) final socket.
      bob.send({ t: 'requestState' });
      for (let guard = 0; guard < 50; guard++) {
        const view = await bob.next('gameView');
        if (view.seq === room.seq - 1) {
          expect((view.event.view.view as RedactedView).phase).toBe('gameOver');
          break;
        }
      }

      expect(ann.received.some((e) => e.event.t === 'error')).toBe(false);
      expectCleanStream(ann);
      expectCleanStream(bob, { allowResumeDuplicates: true });
      expect(d.records.length).toBeGreaterThan(200);
      expect(inspect(d.records, RECONNECT_SEED)).toEqual([]);
    } finally {
      await stopDriverApp(d);
    }
  }, 120000);
});
