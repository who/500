/**
 * Game-log record schema (fh-sja.2). An append-only JSONL corpus of finished
 * Five Hundred games — one {@link GameRecord} per line — captured faithfully
 * enough that every seat's per-hand view is reconstructible offline: the
 * pristine deal, every auction call in table order, the exchange outcome, all
 * ten tricks, and the scored result of each hand. The downstream learning
 * children (fh-sja.3/.4/.5) read this corpus; nothing here interprets it.
 *
 * Versioning: {@link SCHEMA_VERSION} is stamped into every record's `v` field.
 * A reader rejects records whose `v` it does not understand (see reader.ts),
 * so a schema change bumps this constant and the readers that must migrate.
 *
 * Cards are engine card ids (integers 0..44; 44 = joker); bids are the engine
 * {@link Bid} object verbatim — both are already plain JSON, so a record is a
 * pure structural clone with no lossy stringification.
 */

import type { Bid, Card } from '@five-hundred/engine';

/** Bumped whenever the record shape changes in a non-backward-compatible way. */
export const SCHEMA_VERSION = 1;

/** How a seat was played. Bot tiers mirror protocol BotDifficulty. */
export type PolicyKind = 'human' | 'easy' | 'medium' | 'hard';

/**
 * Per-seat provenance. `paramsSchemaVersion` and `overlayHash` pin the
 * BotParams the seat played under once fh-sja.1 externalizes them; until then
 * they are null (the seat used the frozen built-in constants).
 */
export interface PlayerMeta {
  readonly seat: number;
  readonly kind: PolicyKind;
  readonly paramsSchemaVersion: number | null;
  readonly overlayHash: string | null;
}

/** One auction call, in the order it was made. */
export interface AuctionCall {
  readonly seat: number;
  readonly bid: Bid;
}

export interface RecordedTrickPlay {
  readonly seat: number;
  readonly card: Card;
}

export interface RecordedTrick {
  readonly leader: number;
  readonly ledSuit: number;
  readonly plays: readonly RecordedTrickPlay[];
  readonly winner: number;
}

/** The scored outcome of a hand — the engine HandResult, inlined. */
export interface HandOutcome {
  readonly contract: Bid;
  readonly declarer: number;
  readonly slam: boolean;
  readonly made: boolean;
  readonly declarerDelta: number;
  readonly defenderDelta: number;
  readonly declarerSideTricks: number;
  readonly defenderSideTricks: number;
}

/**
 * One completed hand. `deal` is the pristine four hands (10 each) plus the
 * five-card middle as dealt; `redeals` counts dead auctions thrown in before
 * this hand's contract stood. `discards` is the face-down pile after the
 * exchange — with `deal` and `tricks` it makes each seat's play-start hand
 * reconstructible without storing it twice.
 */
export interface HandRecord {
  readonly handNumber: number;
  readonly dealer: number;
  readonly firstBidder: number;
  readonly redeals: number;
  readonly deal: {
    readonly hands: readonly (readonly Card[])[];
    readonly middle: readonly Card[];
  };
  readonly auction: {
    readonly calls: readonly AuctionCall[];
    readonly indications: readonly AuctionCall[];
    readonly contract: Bid | null;
    readonly declarer: number | null;
  };
  readonly slam: boolean;
  readonly activeSeats: readonly number[];
  readonly discards: readonly Card[];
  readonly tricks: readonly RecordedTrick[];
  readonly result: HandOutcome;
  readonly scoresAfter: readonly [number, number];
}

/** One finished game: the JSONL line unit. */
export interface GameRecord {
  /** Schema version; always {@link SCHEMA_VERSION} on write. */
  readonly v: number;
  readonly source: 'server' | 'sim';
  /** Unique within a corpus; a UUID from the server, seed+index from the sim. */
  readonly gameId: string;
  /** The game's engine RNG seed — deals are reproducible from it. */
  readonly seed: number;
  /** ISO-8601 wall-clock time the game finished, or null for headless runs. */
  readonly createdAt: string | null;
  /** Exactly four entries, seat-indexed. */
  readonly players: readonly PlayerMeta[];
  readonly hands: readonly HandRecord[];
  readonly winner: number | null;
  readonly finalScores: readonly [number, number];
}
