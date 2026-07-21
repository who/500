/**
 * Game end and rematch over real ws clients. AC: a hand that decides the
 * game reaches gameOver with no nextHand ready-up (gameOver supersedes it),
 * and the host's rematch command restarts a fresh game in the same room with
 * identical seats/bots and zeroed scores; non-hosts and unfinished games are
 * rejected with typed errors.
 */
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { isGameSession } from '../src/game.js';
import {
  driveUntil,
  setupGame,
  startTestApp,
  stopTestApp,
  type GameFixture,
  type TestApp,
} from './harness.js';

let t: TestApp;
const fixtures: GameFixture[] = [];

beforeAll(async () => {
  t = await startTestApp();
});

afterEach(() => {
  for (const fx of fixtures.splice(0)) {
    fx.ann.close();
    fx.bob.close();
    fx.spectator?.close();
  }
});

afterAll(async () => {
  await stopTestApp(t);
});

async function fixture(): Promise<GameFixture> {
  const fx = await setupGame(t);
  fixtures.push(fx);
  return fx;
}

/**
 * Pin both sides near the winning post mid-play so that however the current
 * hand scores, one side crosses +500 and the game ends on this hand.
 */
async function driveToGameOver(fx: GameFixture): Promise<void> {
  await driveUntil(fx, (s) => s.phase === 'play');
  fx.session.state = { ...fx.session.state, game: { scores: [490, 490], winner: null } };
  await driveUntil(fx, (s) => s.phase === 'gameOver');
}

describe('game end', () => {
  it('reaches gameOver from the deciding hand without any ready-up', async () => {
    const fx = await fixture();
    await driveToGameOver(fx);
    expect(fx.session.state.game.winner).not.toBeNull();

    // Both clients saw handScored then gameOver; nobody ever sent nextHand,
    // so no handReady round happened (gameOver supersedes the ready-up).
    for (const client of [fx.ann, fx.bob]) {
      const types = client.received.map((e) => e.event.t);
      expect(types).not.toContain('handReady');
      const scoredAt = types.indexOf('handScored');
      const overAt = types.indexOf('gameOver');
      expect(scoredAt).toBeGreaterThanOrEqual(0);
      expect(overAt).toBeGreaterThan(scoredAt);
    }
    // The driver's cursor already passed the gameOver, so search the log.
    const over = fx.ann.received.find((e) => e.event.t === 'gameOver');
    expect(over).toBeDefined();
    const event = over!.event;
    if (event.t !== 'gameOver') throw new Error('unreachable');
    expect(event.winner).toBe(fx.session.state.game.winner);
    expect(event.scores).toEqual(fx.session.state.game.scores);
  }, 20000);
});

describe('rematch (AC-3)', () => {
  it('rejects rematch while the game is still running', async () => {
    const fx = await fixture();
    fx.ann.send({ t: 'rematch' });
    expect(await fx.ann.nextError()).toBe('badCommand');
  });

  it('rejects rematch from a non-host with notHost', async () => {
    const fx = await fixture();
    await driveToGameOver(fx);
    fx.bob.send({ t: 'rematch' });
    expect(await fx.bob.nextError()).toBe('notHost');
    expect(fx.room.game).toBe(fx.session);
  }, 20000);

  it('host rematch restarts a fresh game with identical seats/bots and zeroed scores', async () => {
    const fx = await fixture();
    await driveToGameOver(fx);
    const oldSession = fx.session;

    fx.ann.send({ t: 'rematch' });
    // createGameSession broadcasts the opening views before the roomState;
    // scan past any still-buffered views from the finished game.
    const freshView = async (client: GameFixture['ann']) => {
      for (let guard = 0; guard < 20; guard++) {
        const view = (await client.next('gameView')).event.view.view;
        if (view.phase === 'auction') return view;
      }
      throw new Error('no fresh auction view arrived after rematch');
    };
    const annView = await freshView(fx.ann);
    const bobView = await freshView(fx.bob);
    for (const view of [annView, bobView]) {
      expect(view.handNumber).toBe(0);
      expect(view.scores).toEqual([0, 0]);
      expect(view.winner).toBeNull();
      expect(view.hand).toHaveLength(10);
    }
    expect(annView.seat).toBe(0);
    expect(bobView.seat).toBe(2);

    const { room } = await fx.ann.nextRoomState();
    expect(room.started).toBe(true);
    expect(room.seats.map((s) => s.occupant)).toEqual(['human', 'bot', 'human', 'bot']);
    expect(room.seats[0]?.name).toBe('Ann');
    expect(room.seats[2]?.name).toBe('Bob');
    expect(room.hostSeat).toBe(0);

    // The room holds a brand-new session; the finished one was replaced.
    expect(fx.room.game).not.toBe(oldSession);
    expect(isGameSession(fx.room.game)).toBe(true);
  }, 20000);
});
