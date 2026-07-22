/**
 * Game-logging from the headless sim (fh-sja.2 AC-1: a finished bot game
 * produces valid records; AC-2: the sim emits the same schema headlessly). A
 * real 4-bot game is driven through playGameRecording, captured with the
 * shared packages/learn recorder, written to a temp JSONL corpus, and read
 * back through the validating reader.
 */

import { describe, expect, it } from 'vitest';
import { makeRng } from '@five-hundred/engine';
import {
  GameRecorder,
  appendGameRecordSync,
  readGameRecordsSync,
  validateGameRecord,
  type PlayerMeta,
} from '@five-hundred/learn';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediumPolicy } from './medium.js';
import { EasyPolicy } from './easy.js';
import { playGameRecording } from './sim.js';

const KINDS = ['medium', 'easy', 'medium', 'easy'] as const;

function players(): PlayerMeta[] {
  return KINDS.map((kind, seat) => ({ seat, kind, paramsSchemaVersion: null, overlayHash: null }));
}

function policies() {
  return KINDS.map((k) => (k === 'easy' ? new EasyPolicy() : new MediumPolicy()));
}

describe('sim game logging (AC-1 / AC-2)', () => {
  it('records a finished bot game that round-trips through the reader', () => {
    const rng = makeRng(0);
    const gameSeed = rng.int(0x100000000);
    const recorder = new GameRecorder({
      source: 'sim',
      gameId: 'test-0',
      seed: gameSeed,
      createdAt: null,
      players: players(),
    });
    const final = playGameRecording(policies(), rng, gameSeed, (s) => recorder.recordHand(s));
    const record = recorder.finish(final);

    expect(record.source).toBe('sim');
    expect(record.hands.length).toBeGreaterThan(0);
    expect(record.finalScores).toEqual([final.game.scores[0], final.game.scores[1]]);
    // Structurally valid, and the per-seat kinds survived.
    expect(() => validateGameRecord(record)).not.toThrow();
    expect(record.players.map((p) => p.kind)).toEqual([...KINDS]);
  });

  it('appends multiple games to a JSONL corpus readable by packages/learn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-sim-log-'));
    try {
      const path = join(dir, 'corpus.jsonl');
      const rng = makeRng(42);
      for (let i = 0; i < 3; i++) {
        const gameSeed = rng.int(0x100000000);
        const recorder = new GameRecorder({
          source: 'sim',
          gameId: `42-${i}`,
          seed: gameSeed,
          createdAt: null,
          players: players(),
        });
        const final = playGameRecording(policies(), rng, gameSeed, (s) => recorder.recordHand(s));
        appendGameRecordSync(path, recorder.finish(final));
      }
      const read = readGameRecordsSync(path);
      expect(read).toHaveLength(3);
      expect(read.map((r) => r.gameId)).toEqual(['42-0', '42-1', '42-2']);
      for (const r of read) expect(r.hands.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
