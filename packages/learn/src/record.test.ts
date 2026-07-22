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
  parseGameRecords,
  validateGameRecord,
} from './reader.js';
import { serializeGameRecord, writeGameRecordsSync } from './writer.js';
import { readGameRecordsSync } from './reader.js';
import { SCHEMA_VERSION, type PlayerMeta } from './schema.js';
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
  const action = actions[0];
  if (action === undefined) throw new Error(`no legal action for seat ${seat}`);
  if (action.type === 'discardKeeps') {
    return { type: 'discardKeeps', seat, keeps: (state.hands[seat] ?? []).slice(0, 10) };
  }
  return action;
}

/** Drive a full game with the recorder observing each scored hand. */
function playRecordedGame(seed: number): { record: ReturnType<GameRecorder['finish']> } {
  const recorder = new GameRecorder({ source: 'sim', gameId: `seed-${seed}`, seed, players: PLAYERS });
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
