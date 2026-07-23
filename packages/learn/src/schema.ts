/**
 * Game-log record schema (fh-sja.2). An append-only JSONL corpus of finished
 * Five Hundred games — one {@link GameRecord} per line — captured faithfully
 * enough that every seat's per-hand view is reconstructible offline: the
 * pristine deal, every auction call in table order, the exchange outcome, all
 * ten tricks, and the scored result of each hand. The downstream learning
 * children (fh-sja.3/.4/.5) read this corpus; nothing here interprets it.
 *
 * Versioning: {@link SCHEMA_VERSION} is stamped into every record's `v` field.
 * A reader rejects records whose `v` it does not understand (see reader.ts) —
 * {@link SUPPORTED_SCHEMA_VERSIONS} is that accepted set, so a purely additive
 * change bumps the write version while old corpora keep parsing.
 *
 * Cards are engine card ids (integers 0..44; 44 = joker); bids are the engine
 * {@link Bid} object verbatim — both are already plain JSON, so a record is a
 * pure structural clone with no lossy stringification.
 */

import type { Bid, Card } from '@five-hundred/engine';

/** Bumped whenever the record shape changes. Stamped into every write. */
export const SCHEMA_VERSION = 2;

/**
 * Every version this build can read. v1 is v2 without {@link GameRecord.markers}
 * (fh-q2m) — the field is optional, so a v1 line validates unchanged.
 */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1, 2];

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

/**
 * The single play a marker points at (fh-g4g): the last card down in the
 * flagged trick as of the click, which is the decision the flagger was
 * reacting to.
 *
 * `seat` is the 0-based engine seat, like every other seat number in this
 * schema. That matters because the table UI labels seats "Bot 1..4" from 1,
 * so a note typed off the screen calls engine seat 2 "bot 3" — this field,
 * not the prose, is the authority on who played.
 */
export interface FlaggedPlay {
  /** 0-based index of the play within the trick's `plays`. */
  readonly ply: number;
  /** 0-based engine seat that played the card. */
  readonly seat: number;
  readonly card: Card;
}

/**
 * A human-placed pin on one trick (fh-q2m): a player hit "flag this trick" in
 * the table's debug panel because something there looked wrong — usually a bot
 * misplay worth coming back to. Markers are pure annotation; nothing in the
 * record's own consistency depends on them, and a corpus reader may ignore
 * them entirely.
 */
export interface GameMarker {
  /** {@link HandRecord.handNumber} of the flagged hand. */
  readonly hand: number;
  /** 0-based index into that hand's `tricks` — the trick that was on screen. */
  readonly trick: number;
  /** The seat whose viewpoint flagged it (whoever clicked) — 0-based. */
  readonly seat: number;
  /**
   * The play the flag points at (fh-g4g), stamped by the server from live
   * state so the marker names the culprit without a replay. Absent on markers
   * written before this field existed and on flags that land on a trick with
   * no card in it yet.
   */
  readonly flaggedPlay?: FlaggedPlay;
  /** Optional free-text note typed alongside the flag. */
  readonly note?: string;
  /**
   * The cards `seat` still held at the moment of the flag (fh-9f2), sorted
   * ascending so the group reads suit by suit. Only the flagger's own hand is
   * captured. Absent on markers written before this field existed, and on
   * flags that arrive outside the play phase — readers must tolerate both.
   */
  readonly heldCards?: readonly Card[];
  /** ISO-8601 wall-clock time of the click. */
  readonly at: string;
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
  /**
   * Tricks a player flagged while the game ran (fh-q2m), in click order.
   * Omitted entirely when nothing was flagged — which is every v1 record and
   * most v2 ones, so absent and empty mean the same thing.
   */
  readonly markers?: readonly GameMarker[];
}
