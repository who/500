/**
 * Opt-in JSONL game logging (fh-sja.2). AC-1: a finished bot game writes a
 * valid record that round-trips through the packages/learn reader. AC-3:
 * logging is off unless explicitly enabled. The game is driven headlessly
 * through the same validated applyGameAction path human commands use, so no ws
 * choreography is needed to reach gameOver.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { legalActions, toActSeat, type Action, type GameState } from '@five-hundred/engine';
import { readGameRecordsSync, validateGameRecord } from '@five-hundred/learn';
import { resolveGameLogConfig } from '../src/gameLog.js';
import { applyGameAction } from '../src/game.js';
import { setupGame, startTestApp, stopTestApp, type GameFixture, type TestApp } from './harness.js';

const apps: TestApp[] = [];
const dirs: string[] = [];
const fixtures: GameFixture[] = [];

afterEach(async () => {
  for (const fx of fixtures.splice(0)) {
    fx.ann.close();
    fx.bob.close();
  }
  for (const t of apps.splice(0)) await stopTestApp(t);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** First legal action, expanding the discard template to a concrete keep set. */
function firstAction(state: GameState): Action {
  const seat = toActSeat(state);
  if (seat === null) throw new Error(`no actor in phase ${state.phase}`);
  const action = legalActions(state, seat)[0];
  if (action === undefined) throw new Error(`no legal action for seat ${seat}`);
  if (action.type === 'discardKeeps') {
    return { type: 'discardKeeps', seat, keeps: (state.hands[seat] ?? []).slice(0, 10) };
  }
  return action;
}

/** Drive the session to gameOver through the server apply path. */
function driveToGameOver(fx: GameFixture): void {
  for (let guard = 0; guard < 50_000; guard++) {
    const state = fx.session.state;
    if (state.phase === 'gameOver') return;
    if (state.phase === 'handScored') {
      applyGameAction(fx.room, { type: 'nextHand', seat: 0 });
      continue;
    }
    const result = applyGameAction(fx.room, firstAction(state));
    if (!result.ok) throw new Error(`apply rejected: ${result.error.message}`);
  }
  throw new Error('game never reached gameOver');
}

describe('opt-in game logging', () => {
  it('writes a valid record for a finished bot game (AC-1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-server-log-'));
    dirs.push(dir);
    const t = await startTestApp(0xc0ffee, { log: { enabled: true, dir, file: 'games.jsonl' } });
    apps.push(t);
    const fx = await setupGame(t);
    fixtures.push(fx);

    driveToGameOver(fx);

    const path = join(dir, 'games.jsonl');
    const records = readGameRecordsSync(path); // throws if any line is invalid
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(() => validateGameRecord(record)).not.toThrow();
    expect(record.source).toBe('server');
    expect(record.winner).toBe(fx.session.state.game.winner);
    expect(record.finalScores).toEqual([
      fx.session.state.game.scores[0],
      fx.session.state.game.scores[1],
    ]);
    expect(record.hands.length).toBeGreaterThan(0);
    // Seats 0/2 are human, 1/3 are bots in the shared fixture.
    expect(record.players.map((p) => p.kind)).toEqual(['human', 'medium', 'human', 'medium']);
  });

  it('writes nothing when logging is disabled (AC-3)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-server-nolog-'));
    dirs.push(dir);
    const t = await startTestApp(0xc0ffee, { log: { enabled: false, dir, file: 'games.jsonl' } });
    apps.push(t);
    const fx = await setupGame(t);
    fixtures.push(fx);

    driveToGameOver(fx);

    expect(existsSync(join(dir, 'games.jsonl'))).toBe(false);
  });
});

describe('game-log config resolution (AC-3: off by default)', () => {
  it('is disabled with an empty environment', () => {
    expect(resolveGameLogConfig({}).enabled).toBe(false);
  });

  it('enables only on an explicit truthy flag', () => {
    expect(resolveGameLogConfig({ FH_GAME_LOG: '1' }).enabled).toBe(true);
    expect(resolveGameLogConfig({ FH_GAME_LOG: 'true' }).enabled).toBe(true);
    expect(resolveGameLogConfig({ FH_GAME_LOG: '0' }).enabled).toBe(false);
    expect(resolveGameLogConfig({ FH_GAME_LOG: 'yes' }).enabled).toBe(false);
  });

  it('honours dir/file overrides', () => {
    const cfg = resolveGameLogConfig({
      FH_GAME_LOG: '1',
      FH_GAME_LOG_DIR: '/tmp/corpus',
      FH_GAME_LOG_FILE: 'run.jsonl',
    });
    expect(cfg).toMatchObject({ enabled: true, dir: '/tmp/corpus', file: 'run.jsonl' });
  });
});
