/**
 * Bot turn driver (AC-1..AC-3): a scripted human + three bots complete a
 * full game through the validated apply path with zeroed delays; default
 * pacing keeps consecutive bot actions >= 500ms apart (fake-timer
 * inspection); deleting the room cancels pending bot timers; and a
 * validation-rejected bot action crashes the room instead of looping.
 *
 * Driven against the transport-agnostic RoomStore with in-memory clients —
 * the ws transport is covered by the other specs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { legalActions, toActSeat, type Action, type GameState } from '@five-hundred/engine';
import type { BotSeatConfig, Envelope } from '@five-hundred/protocol';
import { EasyPolicy, MediumPolicy } from '@five-hundred/bots';
import {
  BOT_DELAY_MAX_MS,
  BOT_DELAY_MIN_MS,
  defaultBotDelayMs,
  policyFor,
} from '../src/botDriver.js';
import {
  createGameSession,
  handleGameCommand,
  isGameSession,
  type GameCommand,
  type GameSession,
  type GameSessionOptions,
} from '../src/game.js';
import { IDLE_ROOM_MS, RoomStore, type Room, type RoomClient } from '../src/rooms.js';
import { commandFor } from './harness.js';

const SEED = 0xb07;

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

interface Fixture {
  store: RoomStore;
  human: FakeClient;
  room: Room;
  session: GameSession;
}

/** Room with one human (easy bot beside them, medium elsewhere), game started. */
function setup(opts: GameSessionOptions, humanSeat = 0): Fixture {
  const store = new RoomStore({ startGame: (room) => createGameSession(room, SEED, opts) });
  const human = fakeClient();
  store.createRoom(human, 'Ann');
  store.sit(human, humanSeat);
  const room = human.room;
  if (room === null) throw new Error('room not created');
  const botSeats = [0, 1, 2, 3].filter((s) => s !== humanSeat);
  store.configureBots(
    human,
    botSeats.map((seat, i): BotSeatConfig => ({ seat, difficulty: i === 0 ? 'easy' : 'medium' })),
  );
  store.startGame(human);
  const session = room.game;
  if (!isGameSession(session)) throw new Error('game did not start');
  return { store, human, room, session };
}

/** Scripted human: pass every auction, otherwise take the first legal action. */
function humanCommand(state: GameState, seat: number): GameCommand {
  const actions = legalActions(state, seat);
  const action = actions.find((a) => a.type === 'bid' && a.bid.kind === 'PASS') ?? actions[0];
  if (action === undefined) throw new Error(`human seat ${seat} has no legal action in ${state.phase}`);
  // commandFor maps engine actions, so its result is always a game command.
  if (action.type === 'discardKeeps') {
    return commandFor(action, (state.hands[seat] ?? []).slice(0, 10)) as GameCommand;
  }
  return commandFor(action) as GameCommand;
}

describe('bot turn driver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('AC-1: one scripted human + three bots play to gameOver with zero rejections', async () => {
    const { human, session } = setup({ bots: { delayMs: () => 0 } });
    for (let guard = 0; guard < 20000 && session.state.phase !== 'gameOver'; guard++) {
      const state = session.state;
      if (state.phase === 'handScored') {
        handleGameCommand(human, { t: 'nextHand' }); // bots are auto-ready
      } else if (toActSeat(state) === 0) {
        handleGameCommand(human, humanCommand(state, 0));
      }
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(session.state.phase).toBe('gameOver');
    expect(human.sent.filter((e) => e.event.t === 'error')).toEqual([]);
    // A validation-rejected bot action would have crashed the room.
    expect(human.closed).toBe(false);
    expect(vi.getTimerCount()).toBe(0); // nothing left to schedule at gameOver
  });

  it('AC-2: default pacing spaces consecutive bot actions by at least 500ms', async () => {
    const delays: number[] = [];
    const scheduledAt: number[] = [];
    const opts: GameSessionOptions = {
      bots: {
        delayMs: () => {
          const d = defaultBotDelayMs();
          delays.push(d);
          scheduledAt.push(Date.now());
          return d;
        },
      },
    };
    // Human at seat 3: the opening auction starts on bot seat 0.
    const { human, session } = setup(opts, 3);
    const opening = session.state;

    await vi.advanceTimersByTimeAsync(BOT_DELAY_MIN_MS - 1);
    expect(session.state).toBe(opening); // nothing may fire before the floor
    await vi.advanceTimersByTimeAsync(BOT_DELAY_MAX_MS - BOT_DELAY_MIN_MS + 2);
    expect(session.state).not.toBe(opening); // ...and it acts by the ceiling

    // Bid the auction along: bots 0-2 act, then the human passes to hand the
    // turn (and the contract phases) back to the bots.
    await vi.advanceTimersByTimeAsync(6 * BOT_DELAY_MAX_MS);
    handleGameCommand(human, humanCommand(session.state, 3));
    await vi.advanceTimersByTimeAsync(6 * BOT_DELAY_MAX_MS);

    expect(delays.length).toBeGreaterThanOrEqual(5);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(BOT_DELAY_MIN_MS);
      expect(d).toBeLessThan(BOT_DELAY_MAX_MS);
    }
    // A delay is requested at schedule time — i.e. when the previous action
    // applied — so consecutive requests being >= 500ms apart is exactly the
    // pacing gap between consecutive bot actions (tolerance for fractional
    // fake-timer fire times).
    for (let i = 1; i < scheduledAt.length; i++) {
      const gap = (scheduledAt[i] as number) - (scheduledAt[i - 1] as number);
      expect(gap).toBeGreaterThanOrEqual(BOT_DELAY_MIN_MS - 1);
    }
  });

  it('AC-3: deleting the room cancels pending bot timers (no post-deletion sends)', async () => {
    // Default pacing, bot to act: the opening decision timer is pending.
    const { store, human, room, session } = setup({ bots: {} }, 3);
    expect(vi.getTimerCount()).toBe(1);
    const opening = session.state;

    store.sweep(room.lastActivity + IDLE_ROOM_MS + 1);
    expect(store.rooms.size).toBe(0);
    expect(human.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0); // the pacing timer went with the room

    const sentAfterSweep = human.sent.length;
    await vi.advanceTimersByTimeAsync(10 * BOT_DELAY_MAX_MS);
    expect(human.sent.length).toBe(sentAfterSweep); // no post-deletion sends
    expect(session.state).toBe(opening); // and no orphaned state advance
  });

  it('gives every card-counting seat the fallible memory the shipped bots use', () => {
    // fh-8jf.4: the driver's synchronous seats play off the forgetting curve,
    // hung off the game seed so a seat's memory is stable within a hand and
    // independent of its partner's. Easy has no memory of played cards to
    // fuzz — it only ever looks at the trick in front of it.
    const medium = policyFor('medium', SEED);
    expect(medium).toBeInstanceOf(MediumPolicy);
    expect((medium as MediumPolicy).remembers).toBe(true);
    // Hard's real decisions run in the worker (which carries its own memory);
    // this in-thread policy is its degraded fallback and forgets alike.
    expect((policyFor('hard', SEED) as MediumPolicy).remembers).toBe(true);
    expect(policyFor('easy', SEED)).toBeInstanceOf(EasyPolicy);
  });

  it('crashes the room when a bot action is rejected by validation', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, human, room, session } = setup({ bots: { delayMs: () => 0 } }, 3);
    const driver = session.driver;
    if (driver === null) throw new Error('driver missing');
    // Policies only emit legal moves, so forge a decision the engine must
    // reject (declareSlam during the auction) to reach the hard-bug path.
    driver.decide = () => Promise.resolve<Action>({ type: 'declareSlam', seat: 0 });

    await vi.advanceTimersByTimeAsync(5);
    expect(errorLog).toHaveBeenCalledOnce();
    expect(human.closed).toBe(true);
    expect(human.sent.at(-1)?.event).toMatchObject({ t: 'error', code: 'badCommand' });
    expect(room.lastActivity).toBe(0); // marked for instant GC
    expect(store.rooms.size).toBe(1); // still listed until the sweep collects it
    expect(vi.getTimerCount()).toBe(0);
  });
});
