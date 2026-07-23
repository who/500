/**
 * Reading and validating a JSONL game-log corpus. `validateGameRecord` is the
 * round-trip gate the fh-sja.2 acceptance criteria call for: it rejects any
 * object that is not a structurally sound {@link GameRecord} of a version this
 * build understands, so a downstream fitter can trust every field it reads.
 *
 * Validation is structural, not semantic — it checks shapes, versions, and
 * arities, not whether the tricks are legal Five Hundred. Faithful capture is
 * the recorder's job; this side only guards against truncation, corruption,
 * and version drift.
 */

import { readFileSync } from 'node:fs';
import {
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  type GameMarker,
  type GameRecord,
  type HandRecord,
} from './schema.js';

export class GameRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameRecordError';
  }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isIntArray(x: unknown): x is number[] {
  return Array.isArray(x) && x.every((n) => Number.isInteger(n));
}

function isBid(x: unknown): boolean {
  return (
    isObject(x) &&
    typeof x.kind === 'string' &&
    typeof x.level === 'number' &&
    typeof x.strain === 'number'
  );
}

function validateHand(h: unknown, where: string): HandRecord {
  if (!isObject(h)) throw new GameRecordError(`${where}: hand is not an object`);
  if (!Number.isInteger(h.handNumber)) throw new GameRecordError(`${where}: bad handNumber`);
  const deal = h.deal;
  if (
    !isObject(deal) ||
    !Array.isArray(deal.hands) ||
    deal.hands.length !== 4 ||
    !deal.hands.every(isIntArray) ||
    !isIntArray(deal.middle)
  ) {
    throw new GameRecordError(`${where}: bad deal (want 4 card-arrays + a middle)`);
  }
  const auction = h.auction;
  if (
    !isObject(auction) ||
    !Array.isArray(auction.calls) ||
    !auction.calls.every((c) => isObject(c) && Number.isInteger(c.seat) && isBid(c.bid))
  ) {
    throw new GameRecordError(`${where}: bad auction calls`);
  }
  if (!Array.isArray(h.tricks)) throw new GameRecordError(`${where}: tricks is not an array`);
  for (const t of h.tricks) {
    if (
      !isObject(t) ||
      !Number.isInteger(t.leader) ||
      !Number.isInteger(t.winner) ||
      !Array.isArray(t.plays) ||
      !t.plays.every((p) => isObject(p) && Number.isInteger(p.seat) && Number.isInteger(p.card))
    ) {
      throw new GameRecordError(`${where}: bad trick`);
    }
  }
  const result = h.result;
  if (!isObject(result) || !isBid(result.contract) || typeof result.made !== 'boolean') {
    throw new GameRecordError(`${where}: bad result`);
  }
  if (!isIntArray(h.scoresAfter) || (h.scoresAfter as number[]).length !== 2) {
    throw new GameRecordError(`${where}: bad scoresAfter`);
  }
  return h as unknown as HandRecord;
}

/** Shape check for the optional {@link FlaggedPlay} on a marker (fh-g4g). */
function isFlaggedPlay(x: unknown): boolean {
  return (
    isObject(x) &&
    Number.isInteger(x.ply) &&
    Number.isInteger(x.seat) &&
    Number.isInteger(x.card)
  );
}

/**
 * Markers are optional and purely additive (fh-q2m): absent is legal at every
 * version, so only their shape is checked when they are there. `heldCards`
 * (fh-9f2) and `flaggedPlay` (fh-g4g) are likewise optional — older markers
 * simply do not carry them.
 */
function validateMarkers(x: unknown, where: string): void {
  if (!Array.isArray(x)) throw new GameRecordError(`${where}: markers is not an array`);
  x.forEach((m, i) => {
    if (
      !isObject(m) ||
      !Number.isInteger(m.hand) ||
      !Number.isInteger(m.trick) ||
      !Number.isInteger(m.seat) ||
      typeof m.at !== 'string' ||
      (m.note !== undefined && typeof m.note !== 'string') ||
      (m.heldCards !== undefined && !isIntArray(m.heldCards)) ||
      (m.flaggedPlay !== undefined && !isFlaggedPlay(m.flaggedPlay))
    ) {
      throw new GameRecordError(`${where}.markers[${i}]: bad marker`);
    }
  });
}

/**
 * Validate one parsed object as a {@link GameRecord}, throwing a
 * {@link GameRecordError} on any structural or version mismatch. Returns the
 * same object, narrowed, on success.
 */
export function validateGameRecord(obj: unknown, where = 'record'): GameRecord {
  if (!isObject(obj)) throw new GameRecordError(`${where}: not an object`);
  if (typeof obj.v !== 'number' || !SUPPORTED_SCHEMA_VERSIONS.includes(obj.v)) {
    throw new GameRecordError(
      `${where}: unsupported schema version ${String(obj.v)} ` +
        `(this build reads v${SUPPORTED_SCHEMA_VERSIONS.join(', v')}; writes v${SCHEMA_VERSION})`,
    );
  }
  if (obj.source !== 'server' && obj.source !== 'sim') {
    throw new GameRecordError(`${where}: bad source ${String(obj.source)}`);
  }
  if (typeof obj.gameId !== 'string' || !Number.isInteger(obj.seed)) {
    throw new GameRecordError(`${where}: bad gameId/seed`);
  }
  if (obj.createdAt !== null && typeof obj.createdAt !== 'string') {
    throw new GameRecordError(`${where}: bad createdAt`);
  }
  if (!Array.isArray(obj.players) || obj.players.length !== 4) {
    throw new GameRecordError(`${where}: players must have 4 entries`);
  }
  for (const p of obj.players) {
    if (!isObject(p) || !Number.isInteger(p.seat)) {
      throw new GameRecordError(`${where}: bad player entry`);
    }
    if (p.kind !== 'human' && p.kind !== 'easy' && p.kind !== 'medium' && p.kind !== 'hard') {
      throw new GameRecordError(`${where}: bad player kind ${String(p.kind)}`);
    }
  }
  if (!Array.isArray(obj.hands)) throw new GameRecordError(`${where}: hands is not an array`);
  obj.hands.forEach((h, i) => validateHand(h, `${where}.hands[${i}]`));
  if (obj.winner !== null && !Number.isInteger(obj.winner)) {
    throw new GameRecordError(`${where}: bad winner`);
  }
  if (!isIntArray(obj.finalScores) || (obj.finalScores as number[]).length !== 2) {
    throw new GameRecordError(`${where}: bad finalScores`);
  }
  if (obj.markers !== undefined) validateMarkers(obj.markers, where);
  return obj as unknown as GameRecord;
}

/** A record's markers, with absent normalized to empty (fh-q2m). */
export function gameMarkers(record: GameRecord): readonly GameMarker[] {
  return record.markers ?? [];
}

/** Parse and validate every non-blank line of a JSONL corpus. */
export function parseGameRecords(text: string): GameRecord[] {
  const out: GameRecord[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (line === undefined || line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new GameRecordError(`line ${i + 1}: invalid JSON`);
    }
    out.push(validateGameRecord(parsed, `line ${i + 1}`));
  }
  return out;
}

/** Read and validate a JSONL corpus file from disk. */
export function readGameRecordsSync(path: string): GameRecord[] {
  return parseGameRecords(readFileSync(path, 'utf8'));
}
