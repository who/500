/**
 * Authoritative game loop over real ws clients. AC-1: a scripted auction +
 * exchange + first trick (humans on seats 0/2, engine-driven stubs on the
 * bot seats) advances state with strictly increasing seq values on every
 * client. AC-2: illegal commands get a typed error and advance nothing.
 * Also: hand transition via the nextHand ready-up.
 */
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { isEnvelope } from '@five-hundred/protocol';
import {
  driveOpeningTrick,
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

async function fixture(opts: { spectator?: boolean } = {}): Promise<GameFixture> {
  const fx = await setupGame(t, opts);
  fixtures.push(fx);
  return fx;
}

describe('scripted game segment (AC-1)', () => {
  it('advances auction -> exchange -> first trick with strictly increasing seqs', async () => {
    const fx = await fixture();
    expect(fx.annView.phase).toBe('auction');
    expect(fx.annView.hand).toHaveLength(10);
    expect(fx.annView.toAct).toBe(0);
    expect(fx.annReq.actions.length).toBeGreaterThan(0);
    expect(fx.bobReq.actions).toHaveLength(0); // not Bob's turn

    await driveOpeningTrick(fx);

    // The scripted contract stood: Ann declared 7 Spades.
    expect(fx.session.state.contract).toMatchObject({ kind: 'NUM', level: 7, strain: 0 });
    expect(fx.session.state.declarer).toBe(0);

    // Both clients watched the phases advance through the whole segment.
    for (const client of [fx.ann, fx.bob]) {
      const phases = client.gameViews().map((v) => v.phase);
      for (const phase of ['auction', 'slamDecision', 'middleExchange', 'play']) {
        expect(phases).toContain(phase);
      }
    }

    // trickResolved arrived with the completed trick, before the next gameView.
    for (const client of [fx.ann, fx.bob]) {
      const idx = client.received.findIndex((e) => e.event.t === 'trickResolved');
      expect(idx).toBeGreaterThan(-1);
      const resolved = client.received[idx]!.event;
      if (resolved.t !== 'trickResolved') throw new Error('unreachable');
      expect(resolved.trick.plays).toHaveLength(4);
      expect([0, 1, 2, 3]).toContain(resolved.trick.winner);
      const after = client.received.slice(idx + 1);
      expect(after.some((e) => e.event.t === 'gameView')).toBe(true);
    }

    // AC-1 core: every client received strictly increasing seq values, and
    // every envelope passes the protocol guard.
    for (const client of [fx.ann, fx.bob]) {
      const seqs = client.seqs();
      expect(seqs.length).toBeGreaterThan(10);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
      }
      for (const envelope of client.received) {
        expect(isEnvelope(envelope)).toBe(true);
      }
    }
  });
});

describe('illegal commands (AC-2)', () => {
  it('rejects an out-of-turn bid with notYourTurn and advances nothing', async () => {
    const fx = await fixture();
    const before = fx.room.seq;

    // Seat 0 is on turn; Bob (seat 2) tries to bid anyway.
    fx.bob.send({ t: 'bid', bid: { kind: 'NUM', level: 7, strain: 0 } });
    expect(await fx.bob.nextError()).toBe('notYourTurn');

    // No seq was consumed and requestState shows the unchanged state.
    expect(fx.room.seq).toBe(before);
    fx.bob.send({ t: 'requestState' });
    const view = await fx.bob.next('gameView');
    expect(view.seq).toBe(before - 1);
    expect(view.event.view.view.phase).toBe('auction');
    expect(view.event.view.view.toAct).toBe(0);
  });

  it('rejects a phase-mismatched command with illegalAction, state unchanged', async () => {
    const fx = await fixture();
    const before = fx.room.seq;
    fx.ann.send({ t: 'playCard', card: fx.annView.hand[0]! });
    expect(await fx.ann.nextError()).toBe('illegalAction');
    expect(fx.room.seq).toBe(before);
    expect(fx.session.state.phase).toBe('auction');
  });

  it('rejects a double-send: the second copy errors and advances nothing', async () => {
    const fx = await fixture();
    const bid = { kind: 'NUM', level: 7, strain: 0 } as const;
    fx.ann.send({ t: 'bid', bid });
    await fx.ann.next('gameView');
    const before = fx.room.seq;
    fx.ann.send({ t: 'bid', bid }); // turn has moved to seat 1
    expect(await fx.ann.nextError()).toBe('notYourTurn');
    expect(fx.room.seq).toBe(before);
  });

  it('rejects game commands from a socket without a seat with badToken', async () => {
    const fx = await fixture({ spectator: true });
    fx.spectator!.send({ t: 'bid', bid: { kind: 'NUM', level: 7, strain: 0 } });
    expect(await fx.spectator!.nextError()).toBe('badToken');
    fx.spectator!.send({ t: 'requestState' });
    expect(await fx.spectator!.nextError()).toBe('badToken');
  });

  it('rejects nextHand outside handScored with illegalAction', async () => {
    const fx = await fixture();
    fx.ann.send({ t: 'nextHand' });
    expect(await fx.ann.nextError()).toBe('illegalAction');
  });
});

describe('hand transition (ready-up)', () => {
  it('advances to the next hand only after every human seat sends nextHand', async () => {
    const fx = await fixture();
    await driveUntil(fx, (s) => s.phase === 'handScored');

    // The hand-scored transition was broadcast with the result and totals
    // (the driver's cursor already passed it, so search the received log).
    const scored = fx.bob.received.find((e) => e.event.t === 'handScored');
    expect(scored).toBeDefined();
    const event = scored!.event;
    if (event.t !== 'handScored') throw new Error('unreachable');
    expect(event.result.contract).toMatchObject({ kind: 'NUM', level: 7, strain: 0 });
    expect(event.scores).toHaveLength(2);

    // One human readying is not enough: the state stays put, but everyone
    // learns the new ready set (readiness schema v1: bot seats always ready).
    fx.ann.send({ t: 'nextHand' });
    const ready = await fx.bob.next('handReady');
    expect(ready.event.ready).toEqual([0, 1, 3]);
    expect(fx.session.state.phase).toBe('handScored');
    expect(fx.session.ready.has(0)).toBe(true);

    // A re-send is idempotent (no extra handReady broadcast); the second
    // human readying completes the set: hand 1 deals and a fresh auction
    // opens.
    fx.ann.send({ t: 'nextHand' });
    fx.bob.send({ t: 'nextHand' });
    const readyAll = await fx.bob.next('handReady');
    expect(readyAll.event.ready).toEqual([0, 1, 2, 3]);
    const view = await fx.bob.next('gameView');
    expect(view.event.view.view.phase).toBe('auction');
    expect(view.event.view.view.handNumber).toBe(1);
    expect(view.event.view.view.hand).toHaveLength(10);
    expect(fx.session.ready.size).toBe(0);
  }, 20000);
});
