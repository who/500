/**
 * Round-trip and validation tests for the game-log corpus (fh-sja.2 AC-1).
 * A game is driven straight through the engine with a deterministic
 * first-legal-action driver — no bots dependency — so the record layer is
 * exercised in isolation: record -> serialize -> parse -> validate must
 * reproduce the original, and malformed lines must be rejected.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  legalActions,
  newGame,
  toActSeat,
  type Action,
  type GameState,
} from '@five-hundred/engine';
import { GameRecorder } from './record.js';
import {
  GameRecordError,
  gameMarkers,
  parseGameRecords,
  validateGameRecord,
} from './reader.js';
import { serializeGameRecord, writeGameRecordsSync } from './writer.js';
import { readGameRecordsSync } from './reader.js';
import { SCHEMA_VERSION, type GameMarker, type PlayerMeta } from './schema.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PLAYERS: PlayerMeta[] = [0, 1, 2, 3].map((seat) => ({
  seat,
  kind: 'medium',
  paramsSchemaVersion: null,
  overlayHash: null,
}));

/** First legal action, expanding the discard template to a concrete keep set. */
function firstAction(state: GameState): Action {
  const seat = toActSeat(state);
  if (seat === null) throw new Error(`no actor in phase ${state.phase}`);
  const actions = legalActions(state, seat);
  // Never declare a slam: a failed slam scores a constant -500 (fh-wku), which
  // ends the game on the first hand — these fixtures need multi-hand games.
  const action = actions.find((a) => a.type !== 'declareSlam') ?? actions[0];
  if (action === undefined) throw new Error(`no legal action for seat ${seat}`);
  if (action.type === 'discardKeeps') {
    return { type: 'discardKeeps', seat, keeps: (state.hands[seat] ?? []).slice(0, 10) };
  }
  return action;
}

/** Drive a full game with the recorder observing each scored hand. */
function playRecordedGame(
  seed: number,
  markers: readonly GameMarker[] = [],
): { record: ReturnType<GameRecorder['finish']> } {
  const recorder = new GameRecorder({ source: 'sim', gameId: `seed-${seed}`, seed, players: PLAYERS });
  for (const m of markers) recorder.addMarker(m);
  let state = newGame(seed);
  for (let guard = 0; guard < 100_000; guard++) {
    if (state.phase === 'gameOver') break;
    if (state.phase === 'handScored') {
      const before = state;
      const advanced = applyAction(state, { type: 'nextHand', seat: 0 });
      if (!advanced.ok) throw new Error(advanced.error.message);
      state = advanced.state;
      if (before.game.winner !== null) break; // decided game -> gameOver
      continue;
    }
    const result = applyAction(state, firstAction(state));
    if (!result.ok) throw new Error(`illegal action: ${result.error.message}`);
    const next = result.state;
    // Snapshot each hand at its handScored transition (the handScored state is
    // consumed by the branch above, so reaching here means state wasn't it).
    if (next.phase === 'handScored') {
      recorder.recordHand(next);
    }
    state = next;
  }
  return { record: recorder.finish(state) };
}

describe('game-log round-trip (AC-1)', () => {
  it('records a finished game that survives serialize -> parse -> validate', () => {
    const { record } = playRecordedGame(0xabcdef);

    expect(record.v).toBe(SCHEMA_VERSION);
    expect(record.hands.length).toBeGreaterThan(0);
    expect(record.winner).not.toBeNull();
    expect(record.players).toHaveLength(4);

    // Every hand has a pristine deal and a full trick record.
    for (const h of record.hands) {
      expect(h.deal.hands).toHaveLength(4);
      for (const seatHand of h.deal.hands) expect(seatHand).toHaveLength(10);
      expect(h.deal.middle).toHaveLength(5);
      expect(h.tricks).toHaveLength(10);
      expect(h.auction.calls.length).toBeGreaterThanOrEqual(4);
    }

    const line = serializeGameRecord(record);
    const [roundTripped] = parseGameRecords(line);
    expect(roundTripped).toEqual(record);
  });

  it('reconstructs each seat play-start hand from deal + discards + tricks', () => {
    const { record } = playRecordedGame(7);
    const h = record.hands[0]!;
    // Union of a seat's played cards is its 10-card play-start hand.
    for (const seat of h.activeSeats) {
      const played = h.tricks.flatMap((t) => t.plays.filter((p) => p.seat === seat).map((p) => p.card));
      expect(new Set(played).size).toBe(10);
    }
  });

  it('writes and reads a multi-game JSONL corpus', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-learn-'));
    try {
      const path = join(dir, 'games.jsonl');
      const records = [playRecordedGame(1).record, playRecordedGame(2).record];
      writeGameRecordsSync(path, records);
      const read = readGameRecordsSync(path);
      expect(read).toEqual(records);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('flagged-trick markers (fh-q2m)', () => {
  const MARKERS: GameMarker[] = [
    { hand: 0, trick: 3, seat: 2, note: 'bot trumped its partner', at: '2026-07-23T10:00:00.000Z' },
    { hand: 1, trick: 9, seat: 2, at: '2026-07-23T10:04:00.000Z' },
  ];

  it('carries markers added mid-game into the finished record', () => {
    const { record } = playRecordedGame(11, MARKERS);
    expect(record.markers).toEqual(MARKERS);
    // Markers are annotation only: the hands they point at are unchanged.
    expect(record.hands.length).toBeGreaterThan(1);
    expect(record.hands[0]!.tricks).toHaveLength(10);
  });

  it('round-trips a marked record through serialize -> parse -> validate', () => {
    const { record } = playRecordedGame(12, MARKERS);
    const [back] = parseGameRecords(serializeGameRecord(record));
    expect(back).toEqual(record);
    expect(gameMarkers(back!)).toEqual(MARKERS);
  });

  it('omits the field entirely when nothing was flagged', () => {
    const { record } = playRecordedGame(13);
    expect(record.markers).toBeUndefined();
    expect('markers' in record).toBe(false);
    expect(gameMarkers(record)).toEqual([]);
  });

  it('still reads pre-marker (v1) records', () => {
    const { record } = playRecordedGame(14);
    const legacy = { ...record, v: 1 };
    expect(() => validateGameRecord(legacy)).not.toThrow();
    expect(gameMarkers(validateGameRecord(legacy))).toEqual([]);
  });

  it('rejects a malformed marker', () => {
    const { record } = playRecordedGame(15);
    expect(() => validateGameRecord({ ...record, markers: [{ hand: 0 }] })).toThrow(
      GameRecordError,
    );
    expect(() => validateGameRecord({ ...record, markers: 'nope' })).toThrow(GameRecordError);
  });

  describe("the flagger's held cards (fh-9f2)", () => {
    const HELD: GameMarker[] = [
      { hand: 0, trick: 3, seat: 2, heldCards: [4, 17, 44], at: '2026-07-23T10:00:00.000Z' },
    ];

    it('round-trips held cards through serialize -> parse -> validate', () => {
      const { record } = playRecordedGame(16, HELD);
      const [back] = parseGameRecords(serializeGameRecord(record));
      expect(gameMarkers(back!)[0]?.heldCards).toEqual([4, 17, 44]);
    });

    it('accepts markers without held cards (older records)', () => {
      const { record } = playRecordedGame(17, MARKERS);
      expect(() => validateGameRecord(record)).not.toThrow();
      expect(gameMarkers(record).every((m) => m.heldCards === undefined)).toBe(true);
    });

    it('rejects held cards that are not an integer array', () => {
      const { record } = playRecordedGame(18);
      const bad = [{ ...HELD[0]!, heldCards: 'AS KS' }];
      expect(() => validateGameRecord({ ...record, markers: bad })).toThrow(GameRecordError);
    });
  });

  describe('the flagged play (fh-g4g)', () => {
    const PLAYED: GameMarker[] = [
      {
        hand: 0,
        trick: 3,
        seat: 0,
        flaggedPlay: { ply: 2, seat: 2, card: 17 },
        note: 'bot 3 ruffed its partner',
        at: '2026-07-23T10:00:00.000Z',
      },
    ];

    it('round-trips the flagged play through serialize -> parse -> validate', () => {
      const { record } = playRecordedGame(19, PLAYED);
      const [back] = parseGameRecords(serializeGameRecord(record));
      // The note says "bot 3" because that is what the table showed; the
      // field says seat 2, which is what the rest of the corpus means.
      expect(gameMarkers(back!)[0]?.flaggedPlay).toEqual({ ply: 2, seat: 2, card: 17 });
    });

    it('accepts markers without a flagged play (older records)', () => {
      const { record } = playRecordedGame(20, MARKERS);
      expect(() => validateGameRecord(record)).not.toThrow();
      expect(gameMarkers(record).every((m) => m.flaggedPlay === undefined)).toBe(true);
    });

    it('rejects a malformed flagged play', () => {
      const { record } = playRecordedGame(21);
      const missingSeat = [{ ...PLAYED[0]!, flaggedPlay: { ply: 2, card: 17 } }];
      expect(() => validateGameRecord({ ...record, markers: missingSeat })).toThrow(
        GameRecordError,
      );
      const notAnObject = [{ ...PLAYED[0]!, flaggedPlay: 'seat 2 played 8S' }];
      expect(() => validateGameRecord({ ...record, markers: notAnObject })).toThrow(
        GameRecordError,
      );
    });
  });
});

describe('validation rejects malformed records', () => {
  const good = playRecordedGame(3).record;

  it('rejects an unknown schema version', () => {
    expect(() => validateGameRecord({ ...good, v: 999 })).toThrow(GameRecordError);
  });

  it('rejects a bad source', () => {
    expect(() => validateGameRecord({ ...good, source: 'nope' })).toThrow(GameRecordError);
  });

  it('rejects the wrong number of players', () => {
    expect(() => validateGameRecord({ ...good, players: good.players.slice(0, 3) })).toThrow(
      GameRecordError,
    );
  });

  it('rejects a hand with a malformed deal', () => {
    const broken = { ...good, hands: [{ ...good.hands[0], deal: { hands: [], middle: [] } }] };
    expect(() => validateGameRecord(broken)).toThrow(GameRecordError);
  });

  it('rejects invalid JSON lines', () => {
    expect(() => parseGameRecords('{ not json')).toThrow(GameRecordError);
  });

  it('skips blank lines', () => {
    const line = serializeGameRecord(good);
    expect(parseGameRecords(`\n${line}\n\n`)).toHaveLength(1);
  });
});
