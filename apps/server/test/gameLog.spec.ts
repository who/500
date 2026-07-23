/**
 * Opt-in JSONL game logging (fh-sja.2). AC-1: a finished bot game writes a
 * valid record that round-trips through the packages/learn reader. AC-3:
 * logging is off unless explicitly enabled. The game is driven headlessly
 * through the same validated applyGameAction path human commands use, so no ws
 * choreography is needed to reach gameOver.
 *
 * Trick markers (fh-q2m) are the exception: they arrive as a real ws command
 * from a seated client, so those cases go over the socket.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { legalActions, toActSeat, type Action, type GameState } from '@five-hundred/engine';
import { gameMarkers, readGameRecordsSync, validateGameRecord } from '@five-hundred/learn';
import { MAX_MARKER_NOTE, resolveGameLogConfig } from '../src/gameLog.js';
import { applyGameAction } from '../src/game.js';
import {
  driveOpeningTrick,
  driveUntil,
  setupGame,
  startTestApp,
  stopTestApp,
  type GameFixture,
  type TestApp,
} from './harness.js';

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
    expect(record.players.map((p) => p.kind)).toEqual(['human', 'hard', 'human', 'hard']);
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

/**
 * A same-socket round trip: ws messages are processed in order, so a
 * requestState answered means the flagTrick sent before it has been handled.
 */
async function settle(fx: GameFixture): Promise<void> {
  fx.ann.send({ t: 'requestState' });
  await fx.ann.next('gameView');
}

describe('flagged tricks (fh-q2m)', () => {
  it('carries a flagged trick into the finished record, and only then (AC-2/AC-3)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-server-flag-'));
    dirs.push(dir);
    const t = await startTestApp(0xc0ffee, { log: { enabled: true, dir, file: 'games.jsonl' } });
    apps.push(t);
    const fx = await setupGame(t);
    fixtures.push(fx);
    const path = join(dir, 'games.jsonl');

    await driveOpeningTrick(fx);
    const hand = fx.session.state.handNumber;
    // What seat 0 is holding as the flag goes out (fh-9f2): the marker should
    // carry exactly this, not the pristine deal.
    const held = [...(fx.session.state.play?.hands[0] ?? [])].sort((a, b) => a - b);
    expect(held.length).toBeGreaterThan(0);
    const note = 'x'.repeat(MAX_MARKER_NOTE + 50);
    fx.ann.send({ t: 'flagTrick', hand, trick: 0, note });
    await settle(fx);

    // Held in the live recorder — nothing is written until the game ends.
    expect(fx.session.logger?.markers).toHaveLength(1);
    expect(existsSync(path)).toBe(false);

    driveToGameOver(fx);

    const records = readGameRecordsSync(path);
    expect(records).toHaveLength(1);
    const markers = gameMarkers(records[0]!);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ hand, trick: 0, seat: 0 });
    expect(markers[0]?.note).toHaveLength(MAX_MARKER_NOTE); // over-long note truncated
    expect(typeof markers[0]?.at).toBe('string');
    // fh-9f2: the flagger's remaining hand at the flag, not the whole deal.
    expect(markers[0]?.heldCards).toEqual(held);
    // ...and that hand reconstructs from the record itself — the deal (plus
    // the middle, less the discards, if seat 0 declared) minus what seat 0 had
    // already played by the end of the flagged trick.
    const flagged = records[0]!.hands.find((h) => h.handNumber === hand)!;
    const remaining = new Set(flagged.deal.hands[0]!);
    if (flagged.auction.declarer === 0) {
      for (const c of flagged.deal.middle) remaining.add(c);
      for (const c of flagged.discards) remaining.delete(c);
    }
    for (const play of flagged.tricks[0]!.plays) {
      if (play.seat === 0) remaining.delete(play.card);
    }
    expect(markers[0]?.heldCards).toEqual([...remaining].sort((a, b) => a - b));
    // fh-g4g: the marker names the play it points at — the last card down in
    // the flagged trick — with a 0-based ENGINE seat, so the record does not
    // depend on prose typed off a UI that calls seat 2 "Bot 3".
    const lastPlay = flagged.tricks[0]!.plays.at(-1)!;
    expect(markers[0]?.flaggedPlay).toEqual({
      ply: flagged.tricks[0]!.plays.length - 1,
      seat: lastPlay.seat,
      card: lastPlay.card,
    });
    expect(() => validateGameRecord(records[0])).not.toThrow();
  });

  /**
   * AC-1/AC-2 (fh-g4g). Two things are pinned here at once, because they are
   * the same claim from opposite ends: `hand`/`trick` still mean what they
   * always meant — 0-based indices addressing the record's own arrays — and
   * `flaggedPlay.seat` is likewise an engine seat, resolvable straight out of
   * the trick the marker points at with no off-by-one correction.
   */
  it('stamps the engine seat of the play a flag points at, on the trick in progress (AC-1/AC-2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-server-flag-seat-'));
    dirs.push(dir);
    const t = await startTestApp(0xc0ffee, { log: { enabled: true, dir, file: 'games.jsonl' } });
    apps.push(t);
    const fx = await setupGame(t);
    fixtures.push(fx);

    // A trick in progress with at least one card down: the live plays array,
    // not a completed trick, is what the flag has to resolve against.
    await driveUntil(fx, (s) => (s.play?.tricks.length ?? 0) >= 1 && (s.play?.plays.length ?? 0) >= 1);
    const state = fx.session.state;
    const hand = state.handNumber;
    const trick = state.play!.tricks.length;
    const played = state.play!.plays.at(-1)!;
    fx.ann.send({ t: 'flagTrick', hand, trick, note: `bot ${played.seat + 1} looked wrong` });
    await settle(fx);

    driveToGameOver(fx);

    const marker = gameMarkers(readGameRecordsSync(join(dir, 'games.jsonl'))[0]!)[0]!;
    expect(marker.flaggedPlay).toEqual({
      ply: state.play!.plays.length - 1,
      seat: played.seat,
      card: played.card,
    });
    // The note is the human's 1-based wording; the field is the engine's.
    // They disagree by one, and that disagreement is the whole point.
    expect(marker.note).toBe(`bot ${played.seat + 1} looked wrong`);
    expect(marker.flaggedPlay?.seat).toBe(played.seat);

    // AC-2: hand/trick stay 0-based indices into the record's own arrays, so
    // the flagged play is reachable by plain indexing.
    const records = readGameRecordsSync(join(dir, 'games.jsonl'));
    const handRecord = records[0]!.hands.find((h) => h.handNumber === marker.hand)!;
    const recorded = handRecord.tricks[marker.trick]!.plays[marker.flaggedPlay!.ply]!;
    expect(recorded).toEqual({ seat: played.seat, card: played.card });
  });

  it('is a silent no-op when logging is disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-server-flag-off-'));
    dirs.push(dir);
    const t = await startTestApp(0xc0ffee, { log: { enabled: false, dir, file: 'games.jsonl' } });
    apps.push(t);
    const fx = await setupGame(t);
    fixtures.push(fx);

    await driveOpeningTrick(fx);
    fx.ann.send({ t: 'flagTrick', hand: fx.session.state.handNumber, trick: 0 });
    await settle(fx);

    expect(fx.session.logger).toBeNull();
    expect(fx.ann.received.some((e) => e.event.t === 'error')).toBe(false);
    driveToGameOver(fx);
    expect(existsSync(join(dir, 'games.jsonl'))).toBe(false);
  });
});

describe('game-log config resolution (on by default, opt-out)', () => {
  it('is enabled with an empty environment', () => {
    expect(resolveGameLogConfig({}).enabled).toBe(true);
  });

  it('disables only on an explicit off flag', () => {
    expect(resolveGameLogConfig({ FH_GAME_LOG: '0' }).enabled).toBe(false);
    expect(resolveGameLogConfig({ FH_GAME_LOG: 'false' }).enabled).toBe(false);
    expect(resolveGameLogConfig({ FH_GAME_LOG: '1' }).enabled).toBe(true);
    expect(resolveGameLogConfig({ FH_GAME_LOG: 'true' }).enabled).toBe(true);
    expect(resolveGameLogConfig({ FH_GAME_LOG: 'yes' }).enabled).toBe(true);
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
