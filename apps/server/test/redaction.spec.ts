/**
 * Redaction (AC-3): message inspection over a scripted segment proves no
 * gameView sent to a seat ever carries a card id from another hand, the
 * middle, or the discards. Ground truth comes from replaying the fixed seed
 * through the engine: seat 0 (Ann) legitimately owns her deal plus the middle
 * she picked up as declarer; seat 2 (Bob) owns only his deal.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { newGame, type Card, type RedactedView } from '@five-hundred/engine';
import {
  driveOpeningTrick,
  setupGame,
  startTestApp,
  stopTestApp,
  SEED,
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
  }
});

afterAll(async () => {
  await stopTestApp(t);
});

/** Card ids appearing in the view's trick surfaces (public information). */
function trickCards(view: RedactedView): Card[] {
  const cards: Card[] = [];
  for (const play of view.trick?.plays ?? []) cards.push(play.card);
  for (const play of view.lastTrick?.plays ?? []) cards.push(play.card);
  return cards;
}

describe('per-seat redaction (AC-3)', () => {
  it('never leaks another hand, the middle, or the discards into a gameView', async () => {
    const fx = await setupGame(t);
    fixtures.push(fx);
    await driveOpeningTrick(fx);

    // Ground truth for the fixed seed: the same deal the server produced.
    const truth = newGame(SEED);
    const dealt = truth.hands.map((h) => new Set<Card>(h));
    const middle = new Set<Card>(truth.middle);

    // The scripted opening made Ann (seat 0) the declarer, so her ownable set
    // is her deal plus the middle; Bob's is exactly his deal.
    const annOwnable = new Set<Card>([...dealt[0]!, ...middle]);
    const bobOwnable = dealt[2]!;
    expect(fx.session.state.declarer).toBe(0);
    expect(fx.discards).toHaveLength(5); // 15 held, 10 kept

    const annViews = fx.ann.gameViews();
    const bobViews = fx.bob.gameViews();
    expect(annViews.length).toBeGreaterThan(5);
    expect(bobViews.length).toBeGreaterThan(5);

    for (const view of annViews) {
      expect(view.seat).toBe(0);
      for (const card of view.hand) expect(annOwnable.has(card)).toBe(true);
    }
    for (const view of bobViews) {
      expect(view.seat).toBe(2);
      for (const card of view.hand) {
        expect(bobOwnable.has(card)).toBe(true);
        // In particular: nothing from the middle or the other three deals.
        expect(middle.has(card)).toBe(false);
        expect(dealt[0]!.has(card) || dealt[1]!.has(card) || dealt[3]!.has(card)).toBe(false);
      }
    }

    // The discards left play for good: once the discard pile exists, they
    // never show up in any hand or on any trick, on either client's stream.
    // (Ann's exchange-phase views legitimately held them among her 15.)
    const discardSet = new Set<Card>(fx.discards);
    const postDiscard = [...annViews, ...bobViews].filter((v) => v.discardCount > 0);
    expect(postDiscard.length).toBeGreaterThan(0);
    for (const view of postDiscard) {
      for (const card of [...view.hand, ...trickCards(view)]) {
        expect(discardSet.has(card)).toBe(false);
      }
    }

    // Hidden piles are exposed as counts only — no card-bearing middle or
    // discard arrays exist anywhere in the payload.
    for (const view of [...annViews, ...bobViews]) {
      expect(typeof view.middleCount).toBe('number');
      expect(typeof view.discardCount).toBe('number');
      expect('middle' in view).toBe(false);
      expect('discards' in view).toBe(false);
      // Other hands appear only as counts.
      expect(view.handCounts).toHaveLength(4);
    }
  });
});
