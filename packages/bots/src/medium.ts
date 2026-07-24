/**
 * Medium bot — faithful port of the oracle's HeuristicPolicy
 * (five_hundred.py 241-371): strength-based bidding with nulla detection,
 * void-building keeps, cheapest-winner / lose-all-duck play, slam at
 * est >= 8.0, and the joker led into the shortest held suit.
 *
 * Fidelity first: every numeric constant below is the oracle's (except the
 * tuned BID_HEADROOM, recorded as divergence fh-c6i below), named once in
 * this header block with its source line —
 *   _suit_strength (249-271): joker 1.0; bowers 0.95; trump honors 0.55
 *     (Q+) / 0.35 (rest); side ace 0.75, side king 0.25; NT ace 0.9,
 *     king 0.5, queen 0.2
 *   choose_bid (278-298): nulla when lowness >= 8.6, no joker, and no rank
 *     above 11 (jack); max_level = min(10, int(est + 2.5)) with Python
 *     int() truncation (Math.trunc); indication when est >= 4.5 and the
 *     best strain is a suit
 *   consider_slam (342-346): est >= 8.0
 *
 * Tie-breaking: Python's max()/min() return the FIRST extreme element in
 * iteration order, and stable sorts (including reverse=True) preserve the
 * original order of equal keys. To pin those semantics regardless of caller
 * ordering, every method here iterates an ascending-sorted copy of its card
 * inputs (the oracle deals hands sorted the same way), and the parity
 * fixture records sorted contexts. Strains tie-break low (S,C,D,H,NT).
 *
 * The Hard bot reuses this class verbatim as its rollout opponent model, so
 * any drift compounds; divergences from the oracle are recorded here. Five
 * recorded divergences:
 * (fh-zpg) the oracle's choose_bid never saw the auction, so a partner's
 * indication adds a discounted support bonus here that has no Python
 * counterpart; (fh-e52) it never saw the game score either, so an endgame
 * headroom stretch applies when the opponents can win the game off this
 * auction. With no indications and scores clear of the endgame the
 * decisions match the oracle fixture exactly. A third (fh-n2n): the oracle's
 * choose_play never saw the play history, so its declarer led its lowest
 * side card into ruffs; here a declarer-side lead in a trump contract draws
 * trump first, then cashes established side winners (draw gate retuned to
 * expected OPPONENT trumps by fh-61z, which supersedes fh-n2n's raw unseen
 * count). A fifth (fh-61z): the oracle's cheapest-winner follow was
 * partner-blind — it ruffed and overtook its own partner's winners — so a
 * partner-guardrail now ducks those tricks; every parity-fixture context
 * still replays exactly (none offers both a winner and a loser behind a
 * winning partner). A fourth (fh-c6i): the oracle's bid
 * headroom passed out ~91% of deals; live play uses the tuned BID_HEADROOM
 * below, and the parity fixture replays choose_bid at ORACLE_BID_HEADROOM.
 *
 * Those three history heuristics — the trump draw, the NT boss cash, and the
 * partner guardrail's live-threat check — all rest on one seen-set, and a
 * policy given a memory (fh-8jf.3) builds that set through the forgetting
 * curve in memory.ts instead of the true history: a forgotten card returns to
 * the unseen pool and is played around as if it might still be out. A policy
 * constructed WITHOUT a memory is byte-for-byte the perfect-recall bot it has
 * always been, which is what keeps Hard's rollout simulator honest — inside a
 * sampled world, full information is that world's truth, not clairvoyance.
 */

import type { Bid, Card, TrickPlay } from '@five-hundred/engine';
import {
  DECK,
  IND,
  JOKER,
  LADDER,
  NT,
  NULLA,
  NUM,
  PASS,
  SAME_COLOR,
  WIN_SCORE,
  bid,
  cardPower,
  cardRank,
  cardSuit,
  isLoseAll,
  ladderIndex,
  partnerOf,
  trumpOf,
} from '@five-hundred/engine';
import { bestPlaySoFar } from './helpers.js';
import { memorySeed, rememberHistory } from './memory.js';
import { DEFAULT_PARAMS, type BotParams } from './params.js';
import type { BidContext, PlayContext, Policy } from './policy.js';
import { defaultGiveBestCard } from './policy.js';

// Every strategy constant below now lives in BotParams (params/default.json,
// fh-sja.1); the names re-exported here are the checked-in defaults, kept so
// downstream imports (the Hard bot reuses the Medium indication rule verbatim
// and prunes rollout candidates by the same max-level formula, fh-7hw.3) and
// the oracle parity fixture keep working unchanged. A MediumPolicy actually
// reads whatever BotParams it was constructed with; DEFAULT_PARAMS reproduces
// the pre-externalization numbers byte-for-byte.

// The oracle's headroom (max_level = min(10, int(est + 2.5))) needs est >=
// 4.5 to open 7, which ~91% of deals fail on ALL FOUR seats — live tables
// redealt constantly (fh-c6i). The parity fixture replays choose_bid at this
// value; live play uses the tuned bidding.headroom below. This stays a bare
// constant (not a BotParams knob): it pins a historical baseline the fixture
// asserts against, not a tunable.
export const ORACLE_BID_HEADROOM = 2.5;
// Tuned headroom (fh-c6i): opens 7 at est >= 3.0, 8 at 4.0, 9 at 5.0. The
// measured trade-off over 5000 seeded hands of 4 Medium bots (sim-cli
// --hands 5000 --seed 0, re-baselined under the one-pass auction, fh-8i7):
// redeal rate 3.2% (was 90%+ of deals passed out at the oracle's est >= 4.5
// bar), 7+ contract rate 96.7% of deals, set rate 28.4% (was ~9%) as
// est-3.0 openings lean on the partner and the middle.
// Smaller values redeal too often (est >= 3.5 already passes out 29% of
// deals); larger ones push the set rate toward the ~40% AC-1 ceiling.
export const BID_HEADROOM = DEFAULT_PARAMS.bidding.headroom;
export const INDICATE_EST = DEFAULT_PARAMS.bidding.indicateEst;
// A partner indication promises est >= INDICATE_EST in that strain; the
// receiver credits a discounted share of it (fh-zpg), not the full promise,
// so a clearly stronger own-suit plan (raw edge > the bonus) still wins.
// Deliberately beyond the oracle: choose_bid never saw the auction at all.
export const PARTNER_INDICATION_BONUS = DEFAULT_PARAMS.bidding.partnerIndicationBonus;

// Endgame aggression (fh-e52, no oracle counterpart: choose_bid never saw
// the game score). When the opponents end the game by winning this auction,
// passing concedes it, so a longshot contract that merely denies them the
// middle is worth stretching for. The stretch widens once they can also go
// out on defender tricks (10/trick), where owning the contract is the only
// remaining lever. Values below WIN_SCORE - CHEAPEST_CONTRACT leave the bid
// gate untouched, so play away from the endgame is byte-identical.
export const CHEAPEST_CONTRACT = DEFAULT_PARAMS.endgame.cheapestContract; // 7S value
export const ENDGAME_HEADROOM = DEFAULT_PARAMS.endgame.headroom;
export const DESPERATE_HEADROOM = DEFAULT_PARAMS.endgame.desperateHeadroom;
// Four defender tricks (40 pts) end the game from here even if we declare.
export const DESPERATE_SCORE = DEFAULT_PARAMS.endgame.desperateScore;

/** Extra bid headroom the game score justifies for the seat's side. */
export function endgameHeadroom(context: BidContext, params: BotParams = DEFAULT_PARAMS): number {
  const oppScore = context.scores[1 - (context.seat % 2)] as number;
  if (oppScore + params.endgame.cheapestContract < WIN_SCORE) return 0;
  return oppScore >= params.endgame.desperateScore
    ? params.endgame.desperateHeadroom
    : params.endgame.headroom;
}

const ascending = (a: Card, b: Card): number => a - b;

/**
 * Per-seat memory wiring (fh-8jf.3). A MediumPolicy given one plays its
 * history heuristics off the REMEMBERED seen-set (memory.ts) instead of the
 * true one, so it forgets like a human instead of counting cards perfectly.
 */
export interface MediumMemoryOptions {
  /**
   * Base seed the per-seat, per-hand forgetting rolls hang off — normally the
   * game seed. Mixed with the hand number and the acting seat by
   * {@link memorySeed}, so one shared policy object still gives each seat its
   * own independent memory.
   */
  readonly seed: number;
}

export interface MediumOptions {
  /** Absent (the default) means perfect recall; see {@link MediumMemoryOptions}. */
  readonly memory?: MediumMemoryOptions;
}

/** Trump-suit membership under `trump`: joker, both bowers, natural trumps. */
function isTrumpCard(c: Card, trump: number): boolean {
  if (c === JOKER) return true;
  const s = cardSuit(c) as number;
  return s === trump || ((cardRank(c) as number) === 11 && s === SAME_COLOR[trump]);
}

/** First element with the strictly greatest key — Python max() semantics. */
function firstMaxBy(cards: readonly Card[], key: (c: Card) => number): Card {
  let best: Card | undefined;
  let bestKey = -Infinity;
  for (const c of cards) {
    const k = key(c);
    if (k > bestKey) {
      best = c;
      bestKey = k;
    }
  }
  if (best === undefined) throw new Error('empty card pool');
  return best;
}

/** First element with the strictly smallest key — Python min() semantics. */
function firstMinBy(cards: readonly Card[], key: (c: Card) => number): Card {
  let best: Card | undefined;
  let bestKey = Infinity;
  for (const c of cards) {
    const k = key(c);
    if (k < bestKey) {
      best = c;
      bestKey = k;
    }
  }
  if (best === undefined) throw new Error('empty card pool');
  return best;
}

export class MediumPolicy implements Policy {
  /**
   * All strategy constants come from the injected BotParams (fh-sja.1),
   * defaulting to the checked-in DEFAULT_PARAMS. The oracle parity fixture
   * replays choose_bid by constructing with a params whose bidding.headroom is
   * ORACLE_BID_HEADROOM; every live construction uses the tuned default
   * (fh-c6i).
   *
   * `options.memory` is the fh-8jf.3 seam and is deliberately absent by
   * default: a policy constructed without it counts cards perfectly, which is
   * exactly what the Hard bot's rollout simulator seats want (they play out a
   * SAMPLED world, where full information is the truth of that world, not
   * clairvoyance). Only the seats making REAL decisions off the REAL history
   * are given a memory.
   */
  constructor(
    private readonly params: BotParams = DEFAULT_PARAMS,
    private readonly options: MediumOptions = {},
  ) {}

  /** The same policy with a per-seat memory hung off `seed` (fh-8jf.3). */
  withMemory(seed: number): MediumPolicy {
    return new MediumPolicy(this.params, { ...this.options, memory: { seed } });
  }

  /** True when this policy plays off a fuzzed history rather than the true one. */
  get remembers(): boolean {
    return this.options.memory !== undefined;
  }

  /**
   * Rough expected tricks with `strain` as trump (or NT). Oracle
   * _suit_strength (five_hundred.py 245-271); public so specs can pin the
   * weights and the sim harness can report estimates.
   */
  suitStrength(hand: readonly Card[], strain: number): number {
    const trump = strain !== NT ? strain : null;
    const w = this.params.suitStrength;
    const sorted = [...hand].sort(ascending);
    let score = 0.0;
    if (sorted.includes(JOKER)) score += w.joker;
    for (const c of sorted) {
      if (c === JOKER) continue;
      const s = cardSuit(c) as number;
      const r = cardRank(c) as number;
      if (trump !== null) {
        if (r === 11 && (s === trump || s === SAME_COLOR[trump])) score += w.bower;
        else if (s === trump) score += r >= 12 ? w.trumpHonor : w.trumpLow;
        else if (r === 14) score += w.sideAce;
        else if (r === 13) score += w.sideKing;
      } else {
        if (r === 14) score += w.ntAce;
        else if (r === 13) score += w.ntKing;
        else if (r === 12) score += w.ntQueen;
      }
    }
    return score;
  }

  /**
   * How suited the hand is to losing every trick (higher = lower). Oracle
   * _lowness (five_hundred.py 273-276).
   */
  lowness(hand: readonly Card[]): number {
    let sum = 0;
    for (const c of hand) sum += c === JOKER ? 0 : 15 - (cardRank(c) as number);
    return sum / hand.length;
  }

  chooseBid(
    hand: readonly Card[],
    ladderPos: number,
    mayIndicate: boolean,
    context: BidContext,
  ): Bid {
    const p = this.params;
    const sorted = [...hand].sort(ascending);
    // Lose-all option: uniformly low hand, no joker, nothing above a jack.
    if (
      sorted.length > 0 &&
      !sorted.includes(JOKER) &&
      this.lowness(sorted) >= p.bidding.nullaLowness &&
      Math.max(...sorted.map((c) => cardRank(c) as number)) <= p.bidding.nullaMaxRank
    ) {
      const nullaI = ladderIndex(bid(NULLA)) as number;
      if (nullaI > ladderPos) return bid(NULLA);
    }
    const partnerInd = context.indications.find((i) => i.seat === partnerOf(context.seat));
    let bestStrain = 0;
    let est = -Infinity; // partner-boosted, drives the bid
    let ownBestStrain = 0;
    let ownEst = -Infinity; // own hand only, drives our own indication
    for (let s = 0; s < 5; s++) {
      const own = this.suitStrength(sorted, s);
      const strength =
        partnerInd !== undefined && partnerInd.bid.strain === s
          ? own + p.bidding.partnerIndicationBonus
          : own;
      if (strength > est) {
        bestStrain = s;
        est = strength;
      }
      if (own > ownEst) {
        ownBestStrain = s;
        ownEst = own;
      }
    }
    const maxLevel = Math.min(
      10,
      Math.trunc(est + p.bidding.headroom + endgameHeadroom(context, p)),
    );
    if (maxLevel < 7) {
      if (mayIndicate && ownEst >= p.bidding.indicateEst && ownBestStrain < 4) {
        return bid(IND, 6, ownBestStrain);
      }
      return bid(PASS);
    }
    for (let i = ladderPos + 1; i < LADDER.length; i++) {
      const b = LADDER[i] as Bid;
      if (b.kind === NUM && b.strain === bestStrain && b.level <= maxLevel) return b;
      if (b.kind === NUM && b.level > maxLevel) break;
    }
    return bid(PASS);
  }

  chooseKeeps(cards: readonly Card[], contract: Bid): Card[] {
    const trump = trumpOf(contract);
    const sorted = [...cards].sort(ascending);
    if (isLoseAll(contract)) {
      // Keep the ten weakest cards (joker counts as strongest).
      const ranked = [...sorted].sort(
        (a, b) =>
          (a === JOKER ? 99 : (cardRank(a) as number)) -
          (b === JOKER ? 99 : (cardRank(b) as number)),
      );
      return ranked.slice(0, 10);
    }
    // Numbered bids: keep trumps and high side cards; build a void by
    // preferentially shedding the shortest weak side suit.
    const key = (c: Card): readonly [number, number] => {
      if (c === JOKER) return [0, 0];
      const s = cardSuit(c) as number;
      const r = cardRank(c) as number;
      if (trump !== null && (s === trump || (r === 11 && s === SAME_COLOR[trump]))) {
        return [0, 14 - r];
      }
      return [1, 14 - r];
    };
    const bySide = new Map<number, Card[]>();
    for (const c of sorted) {
      if (key(c)[0] === 1) {
        const s = cardSuit(c) as number;
        const suitCards = bySide.get(s);
        if (suitCards === undefined) bySide.set(s, [c]);
        else suitCards.push(c);
      }
    }
    // Rank side suits by (length, top rank): dump the shortest/weakest.
    const topRank = (s: number): number =>
      Math.max(...(bySide.get(s) as Card[]).map((c) => cardRank(c) as number));
    const dumpOrder = [...bySide.keys()].sort(
      (a, b) =>
        (bySide.get(a) as Card[]).length - (bySide.get(b) as Card[]).length ||
        topRank(a) - topRank(b),
    );
    const need = sorted.length - 10;
    const discards: Card[] = [];
    for (const s of dumpOrder) {
      const bySuit = [...(bySide.get(s) as Card[])].sort(
        (a, b) => (cardRank(a) as number) - (cardRank(b) as number),
      );
      for (const c of bySuit) {
        if ((cardRank(c) as number) < 14 && discards.length < need) discards.push(c);
      }
      if (discards.length >= need) break;
    }
    // Fallback: shed globally weakest cards if voids weren't enough. Python
    // sorted(reverse=True) flips comparisons but keeps ties in input order,
    // which a stable descending comparator reproduces.
    if (discards.length < need) {
      const rest = sorted
        .filter((c) => !discards.includes(c))
        .sort((a, b) => {
          const [ga, wa] = key(a);
          const [gb, wb] = key(b);
          return gb - ga || wb - wa;
        });
      for (const c of rest) {
        if (discards.length >= need) break;
        discards.push(c);
      }
    }
    return sorted.filter((c) => !discards.includes(c));
  }

  considerSlam(hand15: readonly Card[], contract: Bid): boolean {
    if (contract.kind !== NUM) return false;
    return this.suitStrength(hand15, contract.strain) >= this.params.slam.est;
  }

  giveBestCard(hand: readonly Card[], contract: Bid): Card {
    return defaultGiveBestCard([...hand].sort(ascending), contract);
  }

  /**
   * The cards this seat believes are already out of play: its own hand, the
   * trick in progress, and every card it has seen played.
   *
   * With no memory configured that is the true union — perfect recall, the
   * pre-fh-8jf.3 behaviour every rollout simulator seat still gets. With a
   * memory, the history goes through the forgetting curve first (memory.ts),
   * so a card the seat has forgotten simply drops out of the set and every
   * heuristic below treats it as possibly still live — the deliberate
   * strength reduction of the fh-8jf epic. The never-forget guarantees are
   * the filter's own: own hand, the current trick and the one before it.
   */
  private seenCards(
    seat: number,
    hand: readonly Card[],
    trump: number | null,
    ledSuit: number | null,
    trickPlays: readonly TrickPlay[],
    context: PlayContext,
  ): ReadonlySet<Card> {
    const memory = this.options.memory;
    if (memory !== undefined) {
      const view = rememberHistory(
        {
          seat,
          seed: memorySeed(memory.seed, context.handNumber ?? 0, seat),
          trump,
          hand,
          tricks: context.tricks,
          current: trickPlays.length === 0 ? null : { ledSuit, plays: trickPlays },
        },
        this.params.hardMemory,
      );
      return new Set(view.seen);
    }
    const seen = new Set<Card>(hand);
    for (const t of context.tricks) for (const p of t.plays) seen.add(p.card);
    for (const p of trickPlays) seen.add(p.card);
    return seen;
  }

  chooseJokerSuit(hand: readonly Card[]): number {
    const counts = [0, 0, 0, 0];
    for (const c of hand) {
      if (c !== JOKER) counts[cardSuit(c) as number] = (counts[cardSuit(c) as number] as number) + 1;
    }
    let shortest = 0;
    for (let s = 1; s < 4; s++) {
      if ((counts[s] as number) < (counts[shortest] as number)) shortest = s;
    }
    return shortest; // lead where we're short
  }

  choosePlay(
    seat: number,
    hand: readonly Card[],
    legal: readonly Card[],
    trickPlays: readonly TrickPlay[],
    trump: number | null,
    ledSuit: number | null,
    contract: Bid,
    context: PlayContext,
  ): Card {
    const sorted = [...legal].sort(ascending);
    let currentMax = -1;
    for (const p of trickPlays) {
      currentMax = Math.max(currentMax, cardPower(p.card, trump, ledSuit));
    }
    // One seen-set for the whole decision (fh-8jf.3), memory-filtered when
    // this policy has a memory. Derived lazily — the lose-all branch below and
    // most follows never need it — and then reused, so a single decision can
    // never contradict itself about whether a card is still out.
    let seenCache: ReadonlySet<Card> | null = null;
    const seenCards = (): ReadonlySet<Card> =>
      (seenCache ??= this.seenCards(seat, hand, trump, ledSuit, trickPlays, context));
    if (isLoseAll(contract)) {
      // Duck with the biggest card that still loses; if forced to win,
      // shed the most dangerous card.
      const losers = sorted.filter((c) => cardPower(c, trump, ledSuit) < currentMax);
      const pool = losers.length > 0 ? losers : sorted;
      return firstMaxBy(pool, (c) =>
        cardPower(c, trump, ledSuit !== null ? ledSuit : cardSuit(c)),
      );
    }
    // Declarer's lead in a trump contract (fh-n2n): draw trump while the
    // opponents may still hold any, then cash established side winners. The
    // unseen set is everything outside this hand and the played tricks, so
    // it includes the partner's trumps and any buried in the discards.
    // Only the WINNING BIDDER draws (fh-1em): the DRAW half used to be gated on
    // the whole declaring side's parity, so the declarer's partner led trump
    // too — timing the draw is the declarer's job, and a partner who leads
    // trump is just guessing with the declarer's own suit. The CASHING half
    // (trump exhausted, so nothing can ruff) stays side-wide: it leads side
    // cards only, and is the trump-contract twin of the fh-2wt NT branch.
    if (
      trump !== null &&
      ledSuit === null &&
      trickPlays.length === 0 &&
      seat % 2 === context.declarer % 2
    ) {
      const seen = seenCards();
      const unseen = DECK.filter((c) => !seen.has(c));
      const outTrumps = unseen.filter((c) => isTrumpCard(c, trump));
      const ownTrumps = sorted.filter((c) => isTrumpCard(c, trump));
      if (seat === context.declarer && outTrumps.length > 0 && ownTrumps.length > 0) {
        const top = firstMaxBy(ownTrumps, (c) => cardPower(c, trump, null));
        const topPower = cardPower(top, trump, null);
        const boss = outTrumps.every((c) => cardPower(c, trump, null) < topPower);
        // Comparing own length against ALL unseen trumps almost never fired
        // (fh-61z defect A): the partner's trumps and the buried middle are
        // not opposition. Scale unseen trumps by each opponent hand's share
        // of the unseen cards instead — on lead every seat has played
        // context.tricks.length cards, so an opponent holds hand.length of
        // the unseen ones. Lead the boss trump, or out-length the expected
        // opponent holding; still never bleed a lone trump into a war this
        // hand cannot win.
        const perOppTrumps = (outTrumps.length * hand.length) / unseen.length;
        if (boss || (ownTrumps.length >= 2 && ownTrumps.length > perOppTrumps)) {
          return top;
        }
      }
      if (outTrumps.length === 0) {
        // Trump is fully out, so a ruff is impossible: cash the biggest side
        // card no unseen card of its suit can beat.
        const sideBosses = sorted.filter(
          (c) =>
            !isTrumpCard(c, trump) &&
            unseen.every(
              (u) =>
                isTrumpCard(u, trump) ||
                cardSuit(u) !== cardSuit(c) ||
                (cardRank(u) as number) < (cardRank(c) as number),
            ),
        );
        if (sideBosses.length > 0) {
          return firstMaxBy(sideBosses, (c) => cardRank(c) as number);
        }
      }
    }
    // Any lead in a no-trump NUM contract (fh-2wt): the fh-n2n branch above is
    // gated on trump !== null and skips NT entirely, so play used to fall
    // through to firstMinBy and open with the LOWEST card. In NT nothing ruffs,
    // so cash from the top: lead the joker (it beats any trick), then
    // unseen-aware side bosses top-down, else lead high from the longest suit
    // to establish it. isLoseAll returned above, so trump === null here means a
    // NUM no-trump contract (nulla/dnulla are lose-all).
    //
    // fh-2wt scoped this to the declaring side; fh-4ww widened it to every
    // seat after game 74a62326 hand 4, where a DEFENDER on lead against 7NT
    // bled its lowest card. The reasoning never depended on which side bid:
    // nothing ruffs for anybody, and the defence in a 10-trick game has to
    // take its tricks before the declarer's length runs. The fh-1em
    // don't-lead-trump companion below is untouched — it is gated on
    // trump !== null, which this branch is not.
    if (trump === null && ledSuit === null && trickPlays.length === 0) {
      // The joker takes any NT trick, subject only to the lead-declares-suit
      // rule, so it is the ultimate cashing lead.
      if (sorted.some((c) => c === JOKER)) return JOKER;
      const seen = seenCards();
      const unseen = DECK.filter((c) => !seen.has(c));
      // While the joker is unseen (and not in hand) it beats every side card,
      // so nothing is a sure winner (AC-2): an ace is not boss until the
      // joker has been seen — fall through to the lead-from-strength path.
      const jokerUnseen = unseen.some((c) => c === JOKER);
      const sideBosses = jokerUnseen
        ? []
        : sorted.filter((c) =>
            unseen.every(
              (u) =>
                cardSuit(u) !== cardSuit(c) || (cardRank(u) as number) < (cardRank(c) as number),
            ),
          );
      if (sideBosses.length > 0) {
        return firstMaxBy(sideBosses, (c) => cardRank(c) as number);
      }
      // No sure winners yet: lead high from our longest suit (tie-break to the
      // higher top card) to establish length, instead of bleeding the lowest.
      let bestSuit = -1;
      let bestLen = 0;
      let bestTop = -1;
      for (let s = 0; s < 4; s++) {
        const inSuit = sorted.filter((c) => cardSuit(c) === s);
        if (inSuit.length === 0) continue;
        const top = cardRank(firstMaxBy(inSuit, (c) => cardRank(c) as number)) as number;
        if (inSuit.length > bestLen || (inSuit.length === bestLen && top > bestTop)) {
          bestLen = inSuit.length;
          bestTop = top;
          bestSuit = s;
        }
      }
      if (bestSuit >= 0) {
        const inSuit = sorted.filter((c) => cardSuit(c) === bestSuit);
        return firstMaxBy(inSuit, (c) => cardRank(c) as number);
      }
    }
    // Nobody but the declarer voluntarily leads trump (fh-1em). The branch
    // above hands the declarer its draw; this is the explicit companion rule
    // for everyone else — the declarer's partner and both defenders. Leading
    // trump for the declarer pulls the opponents' stoppers out of the way, so
    // never CHOOSE a trump on lead while a legal side card exists. The power
    // sort below already picked a side card from a mixed hand (trumps score
    // 2000+, side cards 0 with no led suit), but that was emergent, not a
    // rule: a hand short in side suits, or any retune of the lead heuristic,
    // could still dump a trump. Void-forced trump leads stay legal.
    if (trump !== null && ledSuit === null && trickPlays.length === 0 && seat !== context.declarer) {
      const sideCards = sorted.filter((c) => !isTrumpCard(c, trump));
      if (sideCards.length > 0) {
        return firstMinBy(sideCards, (c) => cardPower(c, trump, ledSuit));
      }
    }
    const winners = sorted.filter((c) => cardPower(c, trump, ledSuit) > currentMax);
    // Partner guardrail (fh-61z defect B, Easy's guardrail (a) ported up):
    // when the partner already holds the trick and a losing card exists,
    // never ruff their side-suit winner, and only overtake when a seat
    // still to act could hold a card that beats the partner's card but not
    // ours — an overtake buys nothing against a card (a ruff, the joker)
    // that beats us too. The oracle parity fixture is unaffected: none of
    // its partner-winning contexts offer both a winner and a loser.
    const best = bestPlaySoFar(trickPlays, trump, ledSuit);
    if (winners.length > 0 && best !== null && best.seat === partnerOf(seat)) {
      const losers = sorted.filter((c) => cardPower(c, trump, ledSuit) < currentMax);
      if (losers.length > 0) {
        const duck = firstMinBy(losers, (c) => cardPower(c, trump, ledSuit));
        const ruffsPartner =
          trump !== null &&
          !isTrumpCard(best.card, trump) &&
          winners.every((c) => isTrumpCard(c, trump));
        if (ruffsPartner) return duck;
        const seatsToAct = 3 - trickPlays.length;
        if (seatsToAct <= 0) return duck;
        const seen = seenCards();
        const topWinPower = cardPower(
          firstMaxBy(winners, (c) => cardPower(c, trump, ledSuit)),
          trump,
          ledSuit,
        );
        const liveThreat = DECK.some((c) => {
          if (seen.has(c)) return false;
          const power = cardPower(c, trump, ledSuit);
          return power > currentMax && power < topWinPower;
        });
        if (!liveThreat) return duck;
      }
    }
    if (winners.length > 0) return firstMinBy(winners, (c) => cardPower(c, trump, ledSuit));
    return firstMinBy(sorted, (c) => cardPower(c, trump, ledSuit));
  }
}
