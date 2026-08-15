/**
 * Env-driven S3-compatible facade over {@link GameRecord}s and learned JSON
 * artifacts (fh-azx.1). Complements the local JSONL writer/reader — it does
 * not replace them. Incomplete env means local-only mode (`null`), never a
 * throw at config time.
 */

import { GameRecordError, validateGameRecord } from './reader.js';
import type { GameRecord } from './schema.js';
import { fetchS3Client, type S3Client } from './s3.js';

/** Env keys that must all be set for {@link createGameStore} to return a store. */
export const STORE_ENV_KEYS = [
  'AWS_ENDPOINT_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_S3_BUCKET_NAME',
  'AWS_DEFAULT_REGION',
] as const;

export type StoreEnv = Record<string, string | undefined>;

/** One record per object so a put is atomic and list+get rebuilds the corpus. */
export const GAMES_PREFIX = 'games/';

/** Agreed artifact keys (relative to {@link FH_STORE_PREFIX}). */
export const OVERLAY_KEY = 'artifacts/overlay.json';
export const CALIBRATION_KEY = 'artifacts/calibration.json';

export function gameObjectKey(gameId: string): string {
  return `${GAMES_PREFIX}${gameId}.json`;
}

export interface GameStore {
  putGame(record: GameRecord): Promise<void>;
  getGame(gameId: string): Promise<GameRecord | null>;
  listGames(): Promise<string[]>;
  readGames(): Promise<GameRecord[]>;
  putJson(key: string, value: unknown): Promise<void>;
  getJson(key: string): Promise<unknown | null>;
}

function requiredEnv(env: StoreEnv): {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
} | null {
  const endpoint = env.AWS_ENDPOINT_URL;
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  const bucket = env.AWS_S3_BUCKET_NAME;
  const region = env.AWS_DEFAULT_REGION;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket || !region) return null;
  return { endpoint, accessKeyId, secretAccessKey, bucket, region };
}

function storePrefix(env: StoreEnv): string {
  return env.FH_STORE_PREFIX ?? '';
}

/**
 * Build a store from env, or `null` when any required var is missing. Pass an
 * {@link S3Client} (typically {@link memoryS3Client}) so tests never open a
 * socket; production callers omit it and get {@link fetchS3Client}.
 */
export function createGameStore(env: StoreEnv, client?: S3Client): GameStore | null {
  const cfg = requiredEnv(env);
  if (cfg === null) return null;
  const prefix = storePrefix(env);
  const s3 = client ?? fetchS3Client(cfg);

  const keyed = (key: string): string => `${prefix}${key}`;

  async function getGame(gameId: string): Promise<GameRecord | null> {
    const body = await s3.get(keyed(gameObjectKey(gameId)));
    if (body === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new GameRecordError(`${gameObjectKey(gameId)}: invalid JSON`);
    }
    return validateGameRecord(parsed, gameObjectKey(gameId));
  }

  return {
    async putGame(record) {
      validateGameRecord(record, gameObjectKey(record.gameId));
      await s3.put(keyed(gameObjectKey(record.gameId)), JSON.stringify(record));
    },
    getGame,
    async listGames() {
      const keys = await s3.list(keyed(GAMES_PREFIX));
      const head = keyed(GAMES_PREFIX);
      const ids: string[] = [];
      for (const key of keys) {
        if (!key.startsWith(head) || !key.endsWith('.json')) continue;
        ids.push(key.slice(head.length, -'.json'.length));
      }
      return ids;
    },
    async readGames() {
      const ids = await this.listGames();
      const records: GameRecord[] = [];
      for (const id of ids) {
        const rec = await getGame(id);
        if (rec !== null) records.push(rec);
      }
      return records;
    },
    async putJson(key, value) {
      await s3.put(keyed(key), JSON.stringify(value));
    },
    async getJson(key) {
      const body = await s3.get(keyed(key));
      if (body === null) return null;
      return JSON.parse(body) as unknown;
    },
  };
}
