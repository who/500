/**
 * Play-log calibrate CLI (fh-azx.3). Drives {@link runCalibrate} against
 * fixture JSONL paths so AC-1..AC-3 never start a live SPRT:
 *
 *   AC-1  A corpus below minSamples exits 0 and writes no overlay or
 *         calibration file.
 *   AC-2  A thick fixture with --skip-sprt writes local.json (schemaVersion
 *         + version + bidding.headroom) and a calibration.json that
 *         parseCalibration accepts.
 *   AC-3  A mocked promoteIfBetter of promote: false leaves the out-dir
 *         unchanged.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NUM, bid } from '@five-hundred/engine';
import {
  type GameRecord,
  type GameStore,
  type HandRecord,
  type PromotionDecision,
  parseCalibration,
} from '@five-hundred/learn';
import {
  DEFAULT_GAME_SERVICE_ID,
  LEARNED_VERSION_VAR,
  RAILWAY_GRAPHQL_URL,
  applyLearnedVersion,
} from '../src/applyOverlay.js';
import { PARAMS_SCHEMA_VERSION } from '../src/params.js';
import { overlayVersion } from '../src/tune.js';
import { runCalibrate } from '../src/calibrate.js';

const tmp = mkdtempSync(join(tmpdir(), 'calibrate-spec-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const WEAK_SPADES = [4, 5, 6, 7, 8, 9, 10, 26, 27, 15];

function numberedHand(made: boolean): HandRecord {
  const hands = [[...WEAK_SPADES], [], [], []];
  return {
    handNumber: 0,
    dealer: 3,
    firstBidder: 0,
    redeals: 0,
    deal: { hands, middle: [] },
    auction: {
      calls: [],
      indications: [],
      contract: bid(NUM, 8, 0),
      declarer: 0,
    },
    slam: false,
    activeSeats: [0, 1, 2, 3],
    discards: [],
    tricks: [],
    result: {
      contract: bid(NUM, 8, 0),
      declarer: 0,
      slam: false,
      made,
      declarerDelta: made ? 240 : -240,
      defenderDelta: 0,
      declarerSideTricks: 0,
      defenderSideTricks: 0,
    },
    scoresAfter: [0, 0],
  };
}

function game(gameId: string, hands: HandRecord[]): GameRecord {
  return {
    v: 1,
    source: 'sim',
    gameId,
    seed: 1,
    createdAt: null,
    players: [0, 1, 2, 3].map((seat) => ({
      seat,
      kind: 'medium' as const,
      paramsSchemaVersion: null,
      overlayHash: null,
    })),
    hands,
    winner: null,
    finalScores: [0, 0],
  };
}

function writeJsonl(name: string, records: readonly GameRecord[]): string {
  const path = join(tmp, name);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : ''));
  return path;
}

function refusePromote(): Promise<PromotionDecision> {
  return Promise.resolve({
    promote: false,
    vsIncumbent: {
      promote: false,
      gamesPlayed: 0,
      seedsPlayed: 0,
      confidence: 1,
      verdict: 'accept-h0',
      wins: 0,
      losses: 0,
      winRate: 0.5,
      llr: 0,
    },
    vsAnchor: null,
  });
}

function acceptPromote(): Promise<PromotionDecision> {
  return Promise.resolve({
    promote: true,
    vsIncumbent: {
      promote: true,
      gamesPlayed: 1,
      seedsPlayed: 1,
      confidence: 1,
      verdict: 'accept-h1',
      wins: 1,
      losses: 0,
      winRate: 1,
      llr: 1,
    },
    vsAnchor: null,
  });
}

function stubStore(): GameStore {
  return {
    putGame: async () => {},
    getGame: async () => null,
    listGames: async () => [],
    readGames: async () => [],
    putJson: async () => {},
    getJson: async () => null,
  };
}

describe('learn:calibrate (fh-azx.3)', () => {
  it('AC-1: a fixture corpus below minSamples exits 0 and writes nothing', async () => {
    const corpus = writeJsonl('thin.jsonl', []);
    const outDir = join(tmp, 'ac1-out');
    await runCalibrate(['--in', corpus, '--out-dir', outDir]);
    expect(existsSync(join(outDir, 'local.json'))).toBe(false);
    expect(existsSync(join(outDir, 'calibration.json'))).toBe(false);
    expect(existsSync(outDir)).toBe(false);
  });

  it('AC-2: a thick fixture with --skip-sprt writes overlay + calibration', async () => {
    const records = Array.from({ length: 40 }, (_, i) => game(`thick-${i}`, [numberedHand(i % 5 !== 0)]));
    const corpus = writeJsonl('thick.jsonl', records);
    const outDir = join(tmp, 'ac2-out');
    await runCalibrate(['--in', corpus, '--out-dir', outDir, '--skip-sprt']);

    const overlayText = readFileSync(join(outDir, 'local.json'), 'utf8');
    const overlay = JSON.parse(overlayText) as {
      schemaVersion?: unknown;
      version?: unknown;
      bidding?: { headroom?: unknown };
    };
    expect(overlay.schemaVersion).toBe(PARAMS_SCHEMA_VERSION);
    expect(typeof overlay.version).toBe('string');
    expect((overlay.version as string).length).toBeGreaterThan(0);
    expect(typeof overlay.bidding?.headroom).toBe('number');
    expect(Number.isFinite(overlay.bidding?.headroom)).toBe(true);
    expect(overlay.version).toBe(overlayVersion(overlay));

    const calText = readFileSync(join(outDir, 'calibration.json'), 'utf8');
    const parsed = parseCalibration(calText);
    expect(parsed.meta.makeSamples).toBeGreaterThanOrEqual(parsed.minSamples);
  });

  it('AC-3: promote: false leaves the out-dir unchanged', async () => {
    const records = Array.from({ length: 40 }, (_, i) => game(`gate-${i}`, [numberedHand(true)]));
    const corpus = writeJsonl('gate.jsonl', records);
    const outDir = join(tmp, 'ac3-out');
    // Seed the out-dir with a sentinel so "unchanged" is observable.
    mkdirSync(outDir, { recursive: true });
    const sentinelPath = join(outDir, 'keep-me.txt');
    writeFileSync(sentinelPath, 'untouched');
    const before = readdirSync(outDir).sort();

    await runCalibrate(['--in', corpus, '--out-dir', outDir], {
      promoteIfBetter: refusePromote,
    });

    expect(readdirSync(outDir).sort()).toEqual(before);
    expect(readFileSync(sentinelPath, 'utf8')).toBe('untouched');
    expect(existsSync(join(outDir, 'local.json'))).toBe(false);
    expect(existsSync(join(outDir, 'calibration.json'))).toBe(false);
  });

  it('usage: neither --in nor --store is an error', async () => {
    await expect(runCalibrate([])).rejects.toThrow(/--in|--store/);
  });

  it('--help documents the operator flags', async () => {
    const lines: string[] = [];
    await runCalibrate(['--help'], { log: (line) => lines.push(line) });
    const text = lines.join('\n');
    for (const flag of ['--in', '--store', '--out-dir', '--upload', '--confirm-games', '--seed']) {
      expect(text).toContain(flag);
    }
    expect(text).toContain('RAILWAY_TOKEN');
    expect(text).toContain('FH_GAME_SERVICE_ID');
  });
});

describe('learn:calibrate apply overlay (fh-azx.8)', () => {
  it('AC-1: mocked promote+upload invokes applyLearnedVersion with the overlay version', async () => {
    const records = Array.from({ length: 40 }, (_, i) => game(`azx8-ac1-${i}`, [numberedHand(true)]));
    const corpus = writeJsonl('azx8-ac1.jsonl', records);
    const outDir = join(tmp, 'azx8-ac1-out');
    const applied: string[] = [];

    await runCalibrate(['--in', corpus, '--out-dir', outDir, '--upload'], {
      promoteIfBetter: acceptPromote,
      createGameStore: () => stubStore(),
      env: {},
      applyLearnedVersion: async (version) => {
        applied.push(version);
      },
    });

    const overlay = JSON.parse(readFileSync(join(outDir, 'local.json'), 'utf8')) as {
      version?: unknown;
    };
    expect(typeof overlay.version).toBe('string');
    expect((overlay.version as string).length).toBeGreaterThan(0);
    expect(applied).toEqual([overlay.version]);
  });

  it('AC-2: thin-corpus skip and SPRT reject do not invoke applyLearnedVersion', async () => {
    const applied: string[] = [];
    const apply = async (version: string): Promise<void> => {
      applied.push(version);
    };

    const thin = writeJsonl('azx8-ac2-thin.jsonl', []);
    await runCalibrate(['--in', thin, '--out-dir', join(tmp, 'azx8-ac2-thin'), '--upload'], {
      createGameStore: () => stubStore(),
      env: {},
      applyLearnedVersion: apply,
    });

    const thick = writeJsonl(
      'azx8-ac2-reject.jsonl',
      Array.from({ length: 40 }, (_, i) => game(`azx8-ac2-${i}`, [numberedHand(true)])),
    );
    await runCalibrate(['--in', thick, '--out-dir', join(tmp, 'azx8-ac2-reject'), '--upload'], {
      promoteIfBetter: refusePromote,
      createGameStore: () => stubStore(),
      env: {},
      applyLearnedVersion: apply,
    });

    expect(applied).toEqual([]);
  });

  it('AC-3: missing RAILWAY_TOKEN warns and still exits 0 after a successful upload', async () => {
    const records = Array.from({ length: 40 }, (_, i) => game(`azx8-ac3-${i}`, [numberedHand(true)]));
    const corpus = writeJsonl('azx8-ac3.jsonl', records);
    const outDir = join(tmp, 'azx8-ac3-out');
    const lines: string[] = [];
    const fetches: unknown[] = [];

    await applyLearnedVersion('should-not-fetch', {}, {
      fetch: async (...args: Parameters<typeof fetch>) => {
        fetches.push(args);
        return new Response('{}', { status: 200 });
      },
      warn: (line) => lines.push(line),
      log: (line) => lines.push(line),
    });
    expect(fetches).toEqual([]);
    expect(lines.join('\n')).toMatch(/RAILWAY_TOKEN/);

    const runLines: string[] = [];
    await runCalibrate(['--in', corpus, '--out-dir', outDir, '--upload', '--skip-sprt'], {
      createGameStore: () => stubStore(),
      env: {},
      log: (line) => runLines.push(line),
    });

    expect(existsSync(join(outDir, 'local.json'))).toBe(true);
    expect(existsSync(join(outDir, 'calibration.json'))).toBe(true);
    expect(runLines.join('\n')).toMatch(/RAILWAY_TOKEN/);
    expect(runLines.join('\n')).toMatch(/PROMOTED/);
  });

  it('applyLearnedVersion posts variableUpsert when RAILWAY_TOKEN is set', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    await applyLearnedVersion('1.deadbeef', { RAILWAY_TOKEN: 'tok' }, {
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ data: { variableUpsert: true } }), { status: 200 });
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(RAILWAY_GRAPHQL_URL);
    const input = (calls[0]?.body as { variables: { input: Record<string, string> } }).variables.input;
    expect(input.name).toBe(LEARNED_VERSION_VAR);
    expect(input.value).toBe('1.deadbeef');
    expect(input.serviceId).toBe(DEFAULT_GAME_SERVICE_ID);
  });
});
