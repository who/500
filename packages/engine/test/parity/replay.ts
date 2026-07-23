/**
 * Streaming parity replayer (fh-gty.2, PRD section 7.2) — the port
 * acceptance gate. Feeds Python-oracle traces (trace_500.py schema v2) into
 * the TS engine through applyAction only and asserts every intermediate
 * observable matches the recording:
 *
 *   deal            reconstructs the hand via initHandFromDeal (rng bypassed)
 *   auction_action  turn, ladder position, indication right, double-nulla
 *                   right, and the full legal bid set implied by
 *                   ladder_pos/may_indicate/may_dnulla; oracle actions the
 *                   TS engine (correctly) refuses to offer — too-low bids,
 *                   repeat indications, a double nulla with no partner
 *                   nulla behind it — must be absent from the TS legal set
 *                   and replay as the PASS the oracle scored them as
 *   auction_result  contract, declarer, indications; on a dead auction the
 *                   engine must have auto-redealt into a fresh auction
 *   exchange        pickup contents, slam flag, give-card, DNULLA pass-
 *                   through, active seats, and the post-exchange hands
 *   play            actor, effective led suit, and the exact legal-play set
 *   trick_winner    winner, led suit, and the played cards in order
 *   hand_result     made, both deltas, and both side trick counts
 *
 * Any mismatch throws a ParityError naming the hand index, attempt, phase,
 * seat, source line, and the expected vs actual values as JSON. Divergences
 * are engine defects (or trace bugs) to file — never loosen an assertion
 * here to make one pass.
 */

import type { Action, Bid, GameState, PlayState } from '../../src/index.js';
import {
  DNULLA,
  IND,
  LADDER,
  NUM,
  NULLA,
  PASS,
  applyAction,
  bid,
  bidKey,
  initHandFromDeal,
  ladderIndex,
  legalActions,
  legalPlaysFor,
  mayDoubleNulla,
  partnerOf,
  playToAct,
} from '../../src/index.js';

const SCHEMA_VERSION = 2;

interface BidJson {
  readonly kind: string;
  readonly level: number;
  readonly strain: number;
}

/** One parsed trace line; extra fields are validated at their use sites. */
interface TraceRecord {
  readonly v: number;
  readonly hand: number;
  readonly first: number;
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface ReplayStats {
  /** Distinct hand indices replayed. */
  hands: number;
  /** Deals consumed, counting every redeal attempt. */
  deals: number;
  redeals: number;
  auctionActions: number;
  exchanges: number;
  plays: number;
  tricks: number;
  handResults: number;
  lines: number;
}

/** A single divergence between the trace and the TS engine. */
export class ParityError extends Error {
  readonly hand: number;
  readonly attempt: number;
  readonly phase: string;
  readonly seat: number | null;
  readonly line: number;
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;

  constructor(
    ctx: { hand: number; attempt: number; phase: string; seat: number | null; line: number },
    field: string,
    expected: unknown,
    actual: unknown,
  ) {
    const seatPart = ctx.seat !== null ? ` seat ${ctx.seat}` : '';
    super(
      `parity divergence at hand ${ctx.hand} attempt ${ctx.attempt} ` +
        `phase ${ctx.phase}${seatPart} (line ${ctx.line}): ${field} ` +
        `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
    );
    this.name = 'ParityError';
    this.hand = ctx.hand;
    this.attempt = ctx.attempt;
    this.phase = ctx.phase;
    this.seat = ctx.seat;
    this.line = ctx.line;
    this.field = field;
    this.expected = expected;
    this.actual = actual;
  }
}

function sortedCards(cards: readonly number[]): number[] {
  return [...cards].sort((a, b) => a - b);
}

function sameCards(a: readonly number[], b: readonly number[]): boolean {
  const sa = sortedCards(a);
  const sb = sortedCards(b);
  return sa.length === sb.length && sa.every((c, i) => c === sb[i]);
}

function toBid(b: BidJson): Bid {
  return { kind: b.kind as Bid['kind'], level: b.level, strain: b.strain };
}

function sameBid(a: Bid | BidJson, b: Bid | BidJson): boolean {
  return a.kind === b.kind && a.level === b.level && a.strain === b.strain;
}

/** Replays one trace, throwing ParityError on the first divergence. */
class Replayer {
  private state: GameState | null = null;
  private hand = -1;
  private attempt = 0;
  private line = 0;
  private readonly seen = new Set<number>();
  readonly stats: ReplayStats = {
    hands: 0,
    deals: 0,
    redeals: 0,
    auctionActions: 0,
    exchanges: 0,
    plays: 0,
    tricks: 0,
    handResults: 0,
    lines: 0,
  };

  private ctx(seat: number | null = null) {
    return {
      hand: this.hand,
      attempt: this.attempt,
      phase: this.state?.phase ?? 'dealing',
      seat,
      line: this.line,
    };
  }

  private diverge(seat: number | null, field: string, expected: unknown, actual: unknown): never {
    throw new ParityError(this.ctx(seat), field, expected, actual);
  }

  private check(cond: boolean, seat: number | null, field: string, expected: unknown, actual: unknown): void {
    if (!cond) this.diverge(seat, field, expected, actual);
  }

  /** The live state, or a divergence if the trace got ahead of the engine. */
  private need(rec: TraceRecord): GameState {
    if (this.state === null) {
      this.diverge(null, `state for ${rec.type} record`, 'a live hand', null);
    }
    return this.state;
  }

  private apply(action: Action): void {
    const result = applyAction(this.need({ type: action.type } as TraceRecord), action);
    if (!result.ok) {
      this.diverge(action.seat, `applyAction(${action.type})`, 'accepted', result.error);
    }
    this.state = result.state;
  }

  step(rawLine: string): void {
    this.line += 1;
    if (rawLine.trim() === '') return;
    this.stats.lines += 1;
    let rec: TraceRecord;
    try {
      rec = JSON.parse(rawLine) as TraceRecord;
    } catch (err) {
      throw new ParityError(
        this.ctx(),
        'trace line JSON',
        'valid JSON',
        `${String(err)}: ${rawLine.slice(0, 120)}`,
      );
    }
    if (rec.v !== SCHEMA_VERSION) {
      this.diverge(null, 'trace schema version', SCHEMA_VERSION, rec.v);
    }
    if (!this.seen.has(rec.hand)) {
      this.seen.add(rec.hand);
      this.stats.hands += 1;
    }
    this.hand = rec.hand;

    switch (rec.type) {
      case 'deal':
        return this.onDeal(rec);
      case 'auction_action':
        return this.onAuctionAction(rec);
      case 'auction_result':
        return this.onAuctionResult(rec);
      case 'exchange':
        return this.onExchange(rec);
      case 'play':
        return this.onPlay(rec);
      case 'trick_winner':
        return this.onTrickWinner(rec);
      case 'hand_result':
        return this.onHandResult(rec);
      default:
        this.diverge(null, 'record type', 'a schema v2 record type', rec.type);
    }
  }

  private onDeal(rec: TraceRecord): void {
    this.attempt = rec.attempt as number;
    const hands = rec.hands as number[][];
    const middle = rec.middle as number[];
    this.state = initHandFromDeal(hands, middle, rec.first);
    this.stats.deals += 1;
    if (this.attempt > 0) this.stats.redeals += 1;
  }

  private onAuctionAction(rec: TraceRecord): void {
    const seat = rec.seat as number;
    const state = this.need(rec);
    const auction = state.auction;
    this.check(state.phase === 'auction' && auction !== null, seat, 'phase', 'auction', state.phase);
    if (auction === null) return; // unreachable; narrows the type
    this.check(auction.turn === seat, seat, 'auction turn', seat, auction.turn);
    this.check(
      auction.ladderPos === rec.ladder_pos,
      seat,
      'ladder position',
      rec.ladder_pos,
      auction.ladderPos,
    );
    const mayIndicate = auction.declarer === null && !auction.indicated[seat];
    this.check(mayIndicate === rec.may_indicate, seat, 'may_indicate', rec.may_indicate, mayIndicate);
    const mayDnulla = mayDoubleNulla(auction, seat);
    this.check(mayDnulla === rec.may_dnulla, seat, 'may_dnulla', rec.may_dnulla, mayDnulla);

    // The recorded ladder_pos + may_indicate + may_dnulla imply the oracle's
    // legal bid set; the engine's legalActions must offer exactly that set.
    const expectedKeys = LADDER.slice((rec.ladder_pos as number) + 1)
      .filter((b) => rec.may_dnulla === true || b.kind !== DNULLA)
      .map(bidKey);
    if (rec.may_indicate) {
      for (let s = 0; s < 5; s++) expectedKeys.push(bidKey(bid(IND, 6, s)));
    }
    expectedKeys.push(bidKey(bid(PASS)));
    const actualKeys = legalActions(state, seat).map((a) =>
      a.type === 'bid' ? bidKey(a.bid) : `non-bid:${a.type}`,
    );
    this.check(
      expectedKeys.length === actualKeys.length && expectedKeys.every((k, i) => k === actualKeys[i]),
      seat,
      'legal bid set',
      expectedKeys,
      actualKeys,
    );

    // Oracle policies may emit bids the auction scores as a pass (too-low
    // ladder bids, indications after the right is spent). The TS engine
    // never offers those, so they must be absent from its legal set and are
    // replayed as the PASS they acted as.
    const recorded = toBid(rec.action as BidJson);
    let action: Bid;
    if (recorded.kind === PASS) {
      action = bid(PASS);
    } else if (actualKeys.includes(bidKey(recorded))) {
      action = recorded;
    } else {
      const idx = ladderIndex(recorded);
      const passLike =
        ((recorded.kind === NUM || recorded.kind === NULLA || recorded.kind === DNULLA) &&
          (idx === undefined || idx <= auction.ladderPos)) ||
        (recorded.kind === DNULLA && !mayDnulla) ||
        (recorded.kind === IND && !mayIndicate);
      this.check(passLike, seat, 'recorded action legality', 'a pass-scored action', rec.action);
      action = bid(PASS);
    }
    this.apply({ type: 'bid', seat, bid: action });
    this.stats.auctionActions += 1;
  }

  private onAuctionResult(rec: TraceRecord): void {
    const state = this.need(rec);
    if (rec.redeal === true) {
      // The engine auto-redeals a dead auction: it must be resting in a
      // fresh auction again (its self-dealt hand is discarded; the trace's
      // next deal record re-initializes the state).
      const fresh =
        state.phase === 'auction' &&
        state.auction !== null &&
        !state.auction.done &&
        state.auction.ladderPos === -1 &&
        state.auction.declarer === null &&
        state.auction.history.length === 0 &&
        state.auction.indications.length === 0 &&
        state.middle.length === 5;
      this.check(fresh, null, 'dead auction', 'an auto-redealt fresh auction', {
        phase: state.phase,
        auction: state.auction,
      });
      this.state = null;
      return;
    }
    const contract = rec.contract as BidJson;
    const declarer = rec.declarer as number;
    this.check(
      state.phase === 'slamDecision' || state.phase === 'middleExchange',
      null,
      'post-auction phase',
      'slamDecision or middleExchange',
      state.phase,
    );
    this.check(
      state.contract !== null && sameBid(state.contract, contract),
      null,
      'contract',
      contract,
      state.contract,
    );
    this.check(state.declarer === declarer, null, 'declarer', declarer, state.declarer);
    const recInd = rec.indications as [number, BidJson][];
    const engInd = state.auction?.indications ?? [];
    this.check(
      recInd.length === engInd.length &&
        recInd.every(([s, b], i) => {
          const e = engInd[i];
          return e !== undefined && e.seat === s && sameBid(e.bid, b);
        }),
      null,
      'indications',
      recInd,
      engInd,
    );
  }

  private onExchange(rec: TraceRecord): void {
    const declarer = rec.declarer as number;
    const contract = rec.contract as BidJson;
    const partner = partnerOf(declarer);
    let state = this.need(rec);
    this.check(state.declarer === declarer, declarer, 'exchange declarer', declarer, state.declarer);
    this.check(
      state.contract !== null && sameBid(state.contract, contract),
      declarer,
      'exchange contract',
      contract,
      state.contract,
    );

    if (contract.kind === NUM) {
      this.check(state.phase === 'slamDecision', declarer, 'phase', 'slamDecision', state.phase);
      if (rec.slam === true) {
        this.apply({ type: 'declareSlam', seat: declarer });
        state = this.need(rec);
        this.check(state.phase === 'partnerCard', partner, 'phase', 'partnerCard', state.phase);
        this.check(rec.give_card !== null, partner, 'slam give_card', 'a card', rec.give_card);
        this.apply({ type: 'giveCard', seat: partner, card: rec.give_card as number });
      } else {
        this.apply({ type: 'declineSlam', seat: declarer });
      }
      state = this.need(rec);
    }

    this.check(state.phase === 'middleExchange', declarer, 'phase', 'middleExchange', state.phase);
    const pickup = state.hands[declarer] ?? [];
    this.check(
      sameCards(pickup, rec.declarer_cards as number[]),
      declarer,
      'declarer pickup',
      sortedCards(rec.declarer_cards as number[]),
      sortedCards(pickup),
    );
    this.apply({ type: 'discardKeeps', seat: declarer, keeps: rec.declarer_keeps as number[] });
    state = this.need(rec);

    if (contract.kind === DNULLA) {
      this.check(state.phase === 'middleExchange', partner, 'phase', 'middleExchange', state.phase);
      const passed = state.exchange?.passed ?? [];
      this.check(
        sameCards(passed, rec.passed as number[]),
        partner,
        'DNULLA pass-through',
        sortedCards(rec.passed as number[]),
        sortedCards(passed),
      );
      const partnerHand = state.hands[partner] ?? [];
      this.check(
        sameCards(partnerHand, rec.partner_cards as number[]),
        partner,
        'DNULLA partner pickup',
        sortedCards(rec.partner_cards as number[]),
        sortedCards(partnerHand),
      );
      this.apply({ type: 'discardKeeps', seat: partner, keeps: rec.partner_keeps as number[] });
      state = this.need(rec);
      this.check(
        sameCards(state.hands[partner] ?? [], rec.partner_keeps as number[]),
        partner,
        'partner keeps',
        sortedCards(rec.partner_keeps as number[]),
        sortedCards(state.hands[partner] ?? []),
      );
    }

    this.check(state.phase === 'play', declarer, 'post-exchange phase', 'play', state.phase);
    this.check(state.slam === rec.slam, declarer, 'slam flag', rec.slam, state.slam);
    const active = rec.active as number[];
    this.check(
      active.length === state.activeSeats.length &&
        active.every((s, i) => s === state.activeSeats[i]),
      declarer,
      'active seats',
      active,
      state.activeSeats,
    );
    this.check(
      sameCards(state.hands[declarer] ?? [], rec.declarer_keeps as number[]),
      declarer,
      'declarer keeps',
      sortedCards(rec.declarer_keeps as number[]),
      sortedCards(state.hands[declarer] ?? []),
    );
    this.stats.exchanges += 1;
  }

  private onPlay(rec: TraceRecord): void {
    const seat = rec.seat as number;
    const state = this.need(rec);
    const play = state.play;
    this.check(state.phase === 'play' && play !== null, seat, 'phase', 'play', state.phase);
    if (play === null) return; // unreachable; narrows the type
    this.check(playToAct(play) === seat, seat, 'seat to play', seat, playToAct(play));
    this.check(play.ledSuit === rec.led_suit, seat, 'led suit', rec.led_suit, play.ledSuit);
    const legal = legalPlaysFor(play, seat);
    this.check(
      sameCards(legal, rec.legal as number[]),
      seat,
      'legal plays',
      sortedCards(rec.legal as number[]),
      sortedCards(legal),
    );
    const namedSuit = rec.named_suit as number | null;
    this.apply({
      type: 'playCard',
      seat,
      card: rec.card as number,
      ...(namedSuit !== null ? { jokerSuit: namedSuit } : {}),
    });
    this.stats.plays += 1;
  }

  private onTrickWinner(rec: TraceRecord): void {
    const state = this.need(rec);
    const play = state.play;
    this.check(play !== null, null, 'play state for trick_winner', 'a play state', state.phase);
    const trick = (play as PlayState).tricks[rec.trick as number];
    this.check(trick !== undefined, null, `completed trick ${String(rec.trick)}`, 'a trick', undefined);
    if (trick === undefined) return; // unreachable; narrows the type
    this.check(trick.winner === rec.winner, null, 'trick winner', rec.winner, trick.winner);
    this.check(trick.ledSuit === rec.led_suit, null, 'trick led suit', rec.led_suit, trick.ledSuit);
    const recPlays = rec.plays as [number, number][];
    this.check(
      recPlays.length === trick.plays.length &&
        recPlays.every(([s, c], i) => trick.plays[i]?.seat === s && trick.plays[i]?.card === c),
      null,
      'trick plays',
      recPlays,
      trick.plays,
    );
    this.stats.tricks += 1;
  }

  private onHandResult(rec: TraceRecord): void {
    const state = this.need(rec);
    const hr = state.handResult;
    this.check(
      state.phase === 'handScored' && hr !== null,
      null,
      'phase',
      'handScored',
      state.phase,
    );
    if (hr === null) return; // unreachable; narrows the type
    this.check(
      sameBid(hr.contract, rec.contract as BidJson),
      null,
      'scored contract',
      rec.contract,
      hr.contract,
    );
    this.check(hr.declarer === rec.declarer, null, 'scored declarer', rec.declarer, hr.declarer);
    this.check(hr.slam === rec.slam, null, 'scored slam', rec.slam, hr.slam);
    this.check(hr.made === rec.made, null, 'made', rec.made, hr.made);
    this.check(
      hr.declarerDelta === rec.declarer_delta,
      null,
      'declarer delta',
      rec.declarer_delta,
      hr.declarerDelta,
    );
    this.check(
      hr.defenderDelta === rec.defender_delta,
      null,
      'defender delta',
      rec.defender_delta,
      hr.defenderDelta,
    );
    this.check(
      hr.declarerSideTricks === rec.declarer_side_tricks,
      null,
      'declarer side tricks',
      rec.declarer_side_tricks,
      hr.declarerSideTricks,
    );
    this.check(
      hr.defenderSideTricks === rec.defender_side_tricks,
      null,
      'defender side tricks',
      rec.defender_side_tricks,
      hr.defenderSideTricks,
    );
    this.stats.handResults += 1;
    this.state = null;
  }
}

/**
 * Replay a schema-v2 trace, line by line. Accepts any (async) iterable of
 * lines so the 10k CLI can stream from disk while tests pass string arrays.
 * Returns run stats; throws ParityError on the first divergence.
 */
export async function replayTrace(
  lines: Iterable<string> | AsyncIterable<string>,
): Promise<ReplayStats> {
  const replayer = new Replayer();
  for await (const line of lines) replayer.step(line);
  return replayer.stats;
}
