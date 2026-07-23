/**
 * Hard-bot worker pool + driver routing — the server-side acceptance
 * criteria of fh-7hw.4:
 *
 *   AC-2  The server answers a concurrent /healthz request while a Hard
 *         decision is in flight: the rollout runs in a worker thread and
 *         never blocks the event loop.
 *   AC-3  A killed worker mid-decision recovers: the pool respawns to
 *         strength and retries the decision once; a second death rejects it,
 *         which the bot driver degrades to a Medium fallback with an error
 *         log instead of a stuck room.
 *
 * Plus the packet's queueing edge case (simultaneous decisions complete FIFO
 * on a single worker, no starvation), worker-side policy errors surfacing as
 * typed rejections without retry, the budget config (fh-x25 AC-3: the raised
 * default, still env-overridable and still clamped), and the BotDriver seam:
 * hard seats route to the pool with sequential per-decision seeds,
 * hardPool: null keeps the synchronous path.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PASS,
  applyAction,
  bid,
  legalPlaysFor,
  makeRng,
  newGame,
  toActSeat,
  type Action,
  type GameState,
} from '@five-hundred/engine';
import { MediumPolicy, botAction, driveHand, policyAction } from '@five-hundred/bots';
import type { BotSeatConfig } from '@five-hundred/protocol';
import { handleRequest } from '../src/index.js';
import { createGameSession, isGameSession, type GameSession, type GameSessionOptions } from '../src/game.js';
import { RoomStore, type Room, type RoomClient } from '../src/rooms.js';
import {
  DEFAULT_HARD_BUDGET_MS,
  HardBotPool,
  MAX_HARD_BUDGET_MS,
  MIN_HARD_BUDGET_MS,
  hardBudgetMs,
  hardPoolSize,
} from '../src/workers/hardPool.js';

const MEDIUM = new MediumPolicy();
const MEDIUMS = [MEDIUM, MEDIUM, MEDIUM, MEDIUM];

/** Walk a seeded Medium game to its first multi-card play decision. */
function stateInPlay(seed: number): { state: GameState; seat: number } {
  const rng = makeRng(seed);
  let state = newGame(seed);
  for (let guard = 0; guard < 10_000; guard++) {
    if (state.phase === 'play') {
      const seat = toActSeat(state);
      if (seat !== null && state.play !== null && legalPlaysFor(state.play, seat).length > 1) {
        return { state, seat };
      }
    }
    const action = botAction(state, MEDIUMS, rng);
    let result = applyAction(state, action);
    if (!result.ok && state.phase === 'auction' && action.type === 'bid') {
      result = applyAction(state, { type: 'bid', seat: action.seat, bid: bid(PASS) });
    }
    if (!result.ok) throw new Error(`walk stalled: ${result.error.message}`);
    state = result.state;
  }
  throw new Error('seeded walk never reached a play decision');
}

function expectLegalPlay(action: Action, state: GameState, seat: number): void {
  expect(action.type).toBe('playCard');
  if (action.type !== 'playCard') return;
  expect(action.seat).toBe(seat);
  if (state.play === null) throw new Error('fixture state is not in play');
  expect(legalPlaysFor(state.play, seat)).toContain(action.card);
}

describe('HardBotPool', () => {
  const pools: HardBotPool[] = [];
  const pool = (size: number, budgetMs: number): HardBotPool => {
    const p = new HardBotPool(size, budgetMs);
    pools.push(p);
    return p;
  };

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((p) => p.dispose()));
  });

  describe('per-decision budget (fh-x25)', () => {
    it('defaults to the raised 1600ms, inside the PRD ceiling', () => {
      expect(DEFAULT_HARD_BUDGET_MS).toBe(1600);
      expect(DEFAULT_HARD_BUDGET_MS).toBeGreaterThan(1000); // the pre-fh-x25 value
      expect(DEFAULT_HARD_BUDGET_MS).toBeLessThanOrEqual(MAX_HARD_BUDGET_MS);
      expect(hardBudgetMs({})).toBe(DEFAULT_HARD_BUDGET_MS);
      expect(hardBudgetMs({ HARD_BOT_BUDGET_MS: '' })).toBe(DEFAULT_HARD_BUDGET_MS);
    });

    it('stays overridable by HARD_BOT_BUDGET_MS and clamped to the ceiling/floor', () => {
      expect(hardBudgetMs({ HARD_BOT_BUDGET_MS: '250' })).toBe(250);
      expect(hardBudgetMs({ HARD_BOT_BUDGET_MS: '99999' })).toBe(MAX_HARD_BUDGET_MS);
      expect(hardBudgetMs({ HARD_BOT_BUDGET_MS: '1' })).toBe(MIN_HARD_BUDGET_MS);
    });

    it('ignores a non-numeric override rather than thinking for NaN ms', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(hardBudgetMs({ HARD_BOT_BUDGET_MS: 'soon' })).toBe(DEFAULT_HARD_BUDGET_MS);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  it('sizes to max(1, cpus - 1) capped at 4', () => {
    expect(hardPoolSize(1)).toBe(1);
    expect(hardPoolSize(2)).toBe(1);
    expect(hardPoolSize(4)).toBe(3);
    expect(hardPoolSize(32)).toBe(4);
  });

  it('AC-2: answers /healthz while a Hard decision is in flight', async () => {
    const p = pool(1, 2000);
    const { state, seat } = stateInPlay(0xac2);
    const server: Server = createServer(handleRequest);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      let decided = false;
      const pending = p.decide(state, seat, 1).finally(() => {
        decided = true;
      });
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
      expect((await res.json()) as { status: string }).toMatchObject({ status: 'ok' });
      // The event loop served the request while the rollout was still going.
      expect(decided).toBe(false);
      expectLegalPlay(await pending, state, seat);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }, 30_000);

  it('AC-3: a killed worker respawns and the retried decision completes', async () => {
    const p = pool(1, 2000);
    const { state, seat } = stateInPlay(0xac3);
    const pending = p.decide(state, seat, 3);
    await p.whenReady(); // the worker is spawned and the job dispatched
    await p.crashWorkers(); // killed mid-decision
    expectLegalPlay(await pending, state, seat);
    expect(p.workerCount).toBe(1); // back at strength
  }, 30_000);

  it('AC-3: a decision whose retry also dies is rejected (driver falls back)', async () => {
    const p = pool(1, 2000);
    const { state, seat } = stateInPlay(0xdead);
    await p.whenReady();
    const pending = p.decide(state, seat, 4); // dispatched to the idle worker
    await p.crashWorkers(); // death #1: respawn + retry
    await p.crashWorkers(); // death #2: give up
    await expect(pending).rejects.toThrow(/exited/);
    expect(p.workerCount).toBe(1); // the pool itself stays serviceable
  }, 30_000);

  it('completes simultaneous decisions FIFO on one worker (no starvation)', async () => {
    const p = pool(1, 200);
    const fixtures = [0x111, 0x222, 0x333].map(stateInPlay);
    const order: number[] = [];
    const actions = await Promise.all(
      fixtures.map(({ state, seat }, i) =>
        p.decide(state, seat, i).then((action) => {
          order.push(i);
          return action;
        }),
      ),
    );
    expect(order).toEqual([0, 1, 2]);
    fixtures.forEach(({ state, seat }, i) => {
      expectLegalPlay(actions[i] as Action, state, seat);
    });
  }, 30_000);

  it('surfaces worker-side policy errors as rejections without retry', async () => {
    const p = pool(1, 2000);
    const rng = makeRng(9);
    const scored = driveHand(newGame(9), MEDIUMS, rng);
    // handScored has no acting seat, so policyAction inside the worker throws.
    await expect(p.decide(scored, 0, 5)).rejects.toThrow(/no Policy method|handScored/);
    expect(p.workerCount).toBe(1); // an error answer is not a crash
  }, 30_000);
});

interface FakeClient extends RoomClient {
  sent: unknown[];
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

/**
 * Human at seat 3, zero pacing delay, injected pool. `configure` is the
 * fh-gpk switch: false leaves the seats exactly as a plain client would (no
 * configureBots ever sent), true names 'hard' explicitly.
 */
function setupHardRoom(
  opts: GameSessionOptions,
  configure = true,
): { room: Room; session: GameSession } {
  const store = new RoomStore({ startGame: (room) => createGameSession(room, 0xb07, opts) });
  const human = fakeClient();
  store.createRoom(human, 'Ann');
  store.sit(human, 3);
  const room = human.room;
  if (room === null) throw new Error('room not created');
  if (configure) {
    store.configureBots(
      human,
      [0, 1, 2].map((seat): BotSeatConfig => ({ seat, difficulty: 'hard' })),
    );
  }
  store.startGame(human);
  const session = room.game;
  if (!isGameSession(session)) throw new Error('game did not start');
  return { room, session };
}

describe('BotDriver hard routing', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('routes hard seats to the pool with sequential per-decision seeds', async () => {
    vi.useFakeTimers();
    const calls: { seat: number; seed: number }[] = [];
    const fakePool = {
      decide(state: GameState, seat: number, seed: number): Promise<Action> {
        calls.push({ seat, seed });
        return Promise.resolve(policyAction(state, seat, MEDIUM, makeRng(seed)));
      },
    };
    const { session } = setupHardRoom({ bots: { delayMs: () => 0, hardPool: fakePool } });
    const opening = session.state;
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(1);
    expect(session.state).not.toBe(opening); // the pool's actions applied
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const [i, call] of calls.entries()) {
      expect([0, 1, 2]).toContain(call.seat); // only hard seats route here
      expect(call.seed).toBe((session.seed + i) >>> 0); // game seed + count
    }
  });

  it('fh-gpk AC-1/AC-2: a client that never configures bots still gets Hard seats routed to the pool', async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const fakePool = {
      decide(state: GameState, seat: number, seed: number): Promise<Action> {
        calls.push(seat);
        return Promise.resolve(policyAction(state, seat, MEDIUM, makeRng(seed)));
      },
    };
    const { room, session } = setupHardRoom({ bots: { delayMs: () => 0, hardPool: fakePool } }, false);

    // Every seat the server filled on its own is a Hard bot...
    expect(room.seats.map((s) => (s.kind === 'human' ? 'human' : s.difficulty))).toEqual([
      'hard',
      'hard',
      'hard',
      'human',
    ]);

    // ...and their decisions really run in the pool, not the Medium fallback.
    const opening = session.state;
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(1);
    expect(session.state).not.toBe(opening);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect([...new Set(calls)].sort()).toEqual([0, 1, 2]);
  });

  it('falls back to a Medium decision with an error log when the pool fails', async () => {
    vi.useFakeTimers();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failingPool = {
      decide: () => Promise.reject(new Error('worker exploded')),
    };
    const { session } = setupHardRoom({ bots: { delayMs: () => 0, hardPool: failingPool } });
    const opening = session.state;
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(1);
    // The game advanced anyway: every failed decision degraded to Medium.
    expect(session.state).not.toBe(opening);
    expect(errorLog).toHaveBeenCalled();
    expect(String(errorLog.mock.calls[0]?.[0])).toContain('Medium fallback');
  });

  it('hardPool: null keeps hard seats on the synchronous in-thread path', async () => {
    vi.useFakeTimers();
    const { session } = setupHardRoom({ bots: { delayMs: () => 0, hardPool: null } });
    const opening = session.state;
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(1);
    expect(session.state).not.toBe(opening); // decisions ran without a pool
  });
});
