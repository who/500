import { describe, expect, it } from 'vitest';
import type { GameState, RedactedView } from '../src/index.js';
import { DNULLA, NT, NULLA, NUM, bid, redactedView } from '../src/index.js';
import { driveGame } from './drive.js';

// Every reachable state of one scripted game per contract class (AC-2).
const GAMES = [
  ['NUM', driveGame(11, { contract: bid(NUM, 10, NT) })],
  ['slam', driveGame(12, { contract: bid(NUM, 7, 0), slam: true })],
  ['nulla', driveGame(13, { contract: bid(NULLA) })],
  ['dnulla', driveGame(14, { contract: bid(DNULLA) })],
] as const;

/** Card ids the seat must never see: other hands, the middle, the discards. */
function hiddenCards(state: GameState, seat: number): Set<number> {
  const hidden = new Set<number>();
  state.hands.forEach((hand, s) => {
    if (s !== seat) for (const c of hand) hidden.add(c);
  });
  for (const c of state.middle) hidden.add(c);
  for (const c of state.discards) hidden.add(c);
  for (const c of state.exchange?.discards ?? []) hidden.add(c);
  // exchange.passed cards sit in the partner's hand and are covered above;
  // the viewer's own hand is legitimately visible even mid-pass-through.
  for (const c of state.hands[seat] ?? []) hidden.delete(c);
  return hidden;
}

/** Every card id a view exposes: own hand plus cards played to tricks. */
function exposedCards(view: RedactedView): number[] {
  return [
    ...view.hand,
    ...(view.trick?.plays ?? []).map((p) => p.card),
    ...(view.lastTrick?.plays ?? []).map((p) => p.card),
  ];
}

/** Keys that would smuggle whole card collections into a view. */
const FORBIDDEN_KEYS = new Set(['hands', 'middle', 'discards', 'passed', 'keeps']);

function forbiddenKeysIn(value: unknown, path = ''): string[] {
  if (value === null || typeof value !== 'object') return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) found.push(`${path}.${key}`);
    found.push(...forbiddenKeysIn(child, `${path}.${key}`));
  }
  return found;
}

describe('redactedView never leaks a hidden card (AC-2)', () => {
  it.each(GAMES.map(([name]) => name))('holds for every state of the %s game', (name) => {
    const { states } = GAMES.find(([n]) => n === name)![1];
    expect(states.length).toBeGreaterThan(10);
    for (const state of states) {
      for (let seat = 0; seat < 4; seat++) {
        const view = redactedView(state, seat);
        const hidden = hiddenCards(state, seat);
        for (const card of exposedCards(view)) {
          if (hidden.has(card)) {
            throw new Error(
              `seat ${seat} sees hidden card ${card} in phase ${state.phase} (hand ${state.handNumber})`,
            );
          }
        }
        expect(forbiddenKeysIn(view)).toEqual([]);
        expect(view.hand).toEqual(state.hands[seat]);
      }
    }
  });

  it('reports hidden zones as counts', () => {
    const { states } = GAMES[0][1];
    const auction = states.find((s) => s.phase === 'auction') as GameState;
    expect(redactedView(auction, 0).middleCount).toBe(5);
    expect(redactedView(auction, 0).handCounts).toEqual([10, 10, 10, 10]);

    const exchange = states.find((s) => s.phase === 'middleExchange') as GameState;
    const declarer = exchange.declarer as number;
    const opponent = (declarer + 1) % 4;
    const seen = redactedView(exchange, opponent);
    expect(seen.middleCount).toBe(0); // picked up...
    expect(seen.handCounts[declarer]).toBe(15); // ...and visible only as a count

    const play = states.find((s) => s.phase === 'play') as GameState;
    expect(redactedView(play, 0).discardCount).toBe(5);
  });
});
