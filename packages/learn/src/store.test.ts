/**
 * S3-compatible corpus store (fh-azx.1). Tests inject {@link memoryS3Client}
 * or a stub `fetch` so nothing here opens a socket.
 */

import { describe, expect, it } from 'vitest';
import { GameRecordError } from './reader.js';
import { SCHEMA_VERSION, type GameRecord, type PlayerMeta } from './schema.js';
import {
  fetchS3Client,
  memoryS3Client,
  signV4,
  type FetchLike,
} from './s3.js';
import {
  CALIBRATION_KEY,
  OVERLAY_KEY,
  STORE_ENV_KEYS,
  createGameStore,
  gameObjectKey,
} from './store.js';

const PLAYERS: PlayerMeta[] = [0, 1, 2, 3].map((seat) => ({
  seat,
  kind: 'medium',
  paramsSchemaVersion: null,
  overlayHash: null,
}));

function sampleRecord(gameId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'): GameRecord {
  return {
    v: SCHEMA_VERSION,
    source: 'sim',
    gameId,
    seed: 1,
    createdAt: null,
    players: PLAYERS,
    hands: [],
    winner: null,
    finalScores: [0, 0],
  };
}

const COMPLETE_ENV = {
  AWS_ENDPOINT_URL: 'https://s3.example.test',
  AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  AWS_S3_BUCKET_NAME: 'fh-play-logs',
  AWS_DEFAULT_REGION: 'us-east-1',
};

describe('createGameStore env (AC-2)', () => {
  it('returns a store when every required var is set', () => {
    expect(createGameStore(COMPLETE_ENV, memoryS3Client())).not.toBeNull();
  });

  it('returns null when any required env var is missing', () => {
    for (const key of STORE_ENV_KEYS) {
      const env = { ...COMPLETE_ENV, [key]: undefined };
      expect(createGameStore(env, memoryS3Client())).toBeNull();
    }
  });

  it('returns null when a required var is empty, and does not throw', () => {
    for (const key of STORE_ENV_KEYS) {
      const env = { ...COMPLETE_ENV, [key]: '' };
      expect(createGameStore(env, memoryS3Client())).toBeNull();
    }
  });
});

describe('GameStore put/get (AC-1)', () => {
  it('puts a valid GameRecord and reads it back by gameId', async () => {
    const client = memoryS3Client();
    const store = createGameStore(COMPLETE_ENV, client);
    if (store === null) throw new Error('expected a store');
    const record = sampleRecord();
    await store.putGame(record);
    expect(await store.getGame(record.gameId)).toEqual(record);
    expect(await store.listGames()).toEqual([record.gameId]);
    expect(await store.readGames()).toEqual([record]);
    expect(await client.get(gameObjectKey(record.gameId))).toBe(JSON.stringify(record));
  });

  it('get of a missing game returns null', async () => {
    const store = createGameStore(COMPLETE_ENV, memoryS3Client());
    if (store === null) throw new Error('expected a store');
    expect(await store.getGame('missing')).toBeNull();
    expect(await store.listGames()).toEqual([]);
    expect(await store.readGames()).toEqual([]);
  });

  it('round-trips overlay and calibration JSON through putJson/getJson', async () => {
    const store = createGameStore(COMPLETE_ENV, memoryS3Client());
    if (store === null) throw new Error('expected a store');
    await store.putJson(OVERLAY_KEY, { v: 1, params: { foo: 2 } });
    await store.putJson(CALIBRATION_KEY, { v: 1, cells: {} });
    expect(await store.getJson(OVERLAY_KEY)).toEqual({ v: 1, params: { foo: 2 } });
    expect(await store.getJson(CALIBRATION_KEY)).toEqual({ v: 1, cells: {} });
    expect(await store.getJson('artifacts/absent.json')).toBeNull();
  });

  it('honours FH_STORE_PREFIX on object keys', async () => {
    const client = memoryS3Client();
    const store = createGameStore({ ...COMPLETE_ENV, FH_STORE_PREFIX: 'staging/' }, client);
    if (store === null) throw new Error('expected a store');
    const record = sampleRecord();
    await store.putGame(record);
    expect(await client.get(`staging/${gameObjectKey(record.gameId)}`)).toBe(JSON.stringify(record));
    expect(await store.getGame(record.gameId)).toEqual(record);
  });
});

describe('GameStore validation (AC-3)', () => {
  it('throws GameRecordError when a fetched object fails validateGameRecord', async () => {
    const client = memoryS3Client({
      [gameObjectKey('bad')]: JSON.stringify({ v: 999, gameId: 'bad', source: 'sim' }),
    });
    const store = createGameStore(COMPLETE_ENV, client);
    if (store === null) throw new Error('expected a store');
    await expect(store.getGame('bad')).rejects.toBeInstanceOf(GameRecordError);
    await expect(store.readGames()).rejects.toBeInstanceOf(GameRecordError);
  });

  it('does not return a record that failed validation', async () => {
    const client = memoryS3Client({
      [gameObjectKey('bad')]: JSON.stringify({ v: 999, gameId: 'bad', source: 'sim' }),
    });
    const store = createGameStore(COMPLETE_ENV, client);
    if (store === null) throw new Error('expected a store');
    let returned: GameRecord | null | undefined;
    try {
      returned = await store.getGame('bad');
    } catch (err) {
      expect(err).toBeInstanceOf(GameRecordError);
      expect(returned).toBeUndefined();
      return;
    }
    throw new Error('expected validateGameRecord to throw');
  });

  it('throws GameRecordError on corrupt JSON', async () => {
    const client = memoryS3Client({ [gameObjectKey('bad')]: 'not-json' });
    const store = createGameStore(COMPLETE_ENV, client);
    if (store === null) throw new Error('expected a store');
    await expect(store.getGame('bad')).rejects.toBeInstanceOf(GameRecordError);
  });
});

describe('signV4 AWS GET Object fixture', () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
  it('matches the documented GET /test.txt signature', () => {
    const signed = signV4({
      method: 'GET',
      canonicalUri: '/test.txt',
      headers: {
        host: 'examplebucket.s3.amazonaws.com',
        range: 'bytes=0-9',
        'x-amz-content-sha256':
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date': '20130524T000000Z',
      },
      payload: '',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      amzDate: '20130524T000000Z',
    });
    expect(signed.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    expect(signed.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});

describe('memoryS3Client', () => {
  it('puts, gets, and lists; missing get is null; empty prefix list is empty', async () => {
    const client = memoryS3Client();
    expect(await client.list('games/')).toEqual([]);
    expect(await client.get('games/x.json')).toBeNull();
    await client.put('games/a.json', '{"a":1}');
    await client.put('artifacts/overlay.json', '{}');
    expect(await client.get('games/a.json')).toBe('{"a":1}');
    expect(await client.list('games/')).toEqual(['games/a.json']);
  });
});

describe('fetchS3Client (stub fetch, no network)', () => {
  const cfg = {
    endpoint: 'https://s3.example.test',
    accessKeyId: COMPLETE_ENV.AWS_ACCESS_KEY_ID,
    secretAccessKey: COMPLETE_ENV.AWS_SECRET_ACCESS_KEY,
    bucket: 'fh-play-logs',
    region: 'us-east-1',
  };
  const frozen = () => new Date('2013-05-24T00:00:00.000Z');

  it('PUTs a signed path-style object', async () => {
    const seen: { url: string; method?: string; headers?: Record<string, string>; body?: string }[] =
      [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
      return { ok: true, status: 200, text: async () => '' };
    };
    const client = fetchS3Client(cfg, { fetch: fetchImpl, now: frozen });
    await client.put('games/g.json', '{"ok":true}');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('PUT');
    expect(seen[0]?.url).toBe('https://s3.example.test/fh-play-logs/games/g.json');
    expect(seen[0]?.headers?.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
    expect(seen[0]?.body).toBe('{"ok":true}');
  });

  it('GET of HTTP 404 returns null', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 404,
      text: async () => 'NoSuchKey',
    });
    const client = fetchS3Client(cfg, { fetch: fetchImpl, now: frozen });
    expect(await client.get('games/missing.json')).toBeNull();
  });

  it('lists keys from ListObjectsV2 XML, including an empty bucket', async () => {
    const empty: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',
    });
    expect(await fetchS3Client(cfg, { fetch: empty, now: frozen }).list('games/')).toEqual([]);

    const listed: FetchLike = async (url) => {
      expect(url).toContain('list-type=2');
      expect(url).toContain('prefix=games%2F');
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<ListBucketResult><Contents><Key>games/a.json</Key></Contents>' +
          '<Contents><Key>games/b.json</Key></Contents></ListBucketResult>',
      };
    };
    expect(await fetchS3Client(cfg, { fetch: listed, now: frozen }).list('games/')).toEqual([
      'games/a.json',
      'games/b.json',
    ]);
  });
});
