/**
 * Medium bot — faithful port of the oracle's HeuristicPolicy
 * (five_hundred.py 241-371): strength-based bidding with nulla detection,
 * void-building keeps, cheapest-winner / lose-all-duck play, slam at
 * est >= 8.0, and the joker led into the shortest held suit.
 *
 * Fidelity first: every numeric constant below is the oracle's, named once
 * in this header block with its source line —
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
 * No tuning or strength improvements here — the strength gate lives in the
 * sim-harness leaf, and the Hard bot reuses this class verbatim as its
 * rollout opponent model, so any drift compounds. Two recorded divergences:
 * (fh-zpg) the oracle's choose_bid never saw the auction, so a partner's
 * indication adds a discounted support bonus here that has no Python
 * counterpart; (fh-e52) it never saw the game score either, so an endgame
 * headroom stretch applies when the opponents can win the game off this
 * auction. With no indications and scores clear of the endgame the
 * decisions match the oracle fixture exactly. A third (fh-n2n): the oracle's
 * choose_play never saw the play history, so its declarer led its lowest
 * side card into ruffs; here a declarer-side lead in a trump contract draws
 * trump first, then cashes established side winners. Defender play (the
 * fixture context) is untouched.
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
import type { BidContext, PlayContext, Policy } from './policy.js';
import { defaultGiveBestCard } from './policy.js';

// _suit_strength weights (five_hundred.py 249-271)
const JOKER_TRICKS = 1.0;
const BOWER = 0.95;
const TRUMP_HONOR = 0.55; // trump Q or better (bowers scored above)
const TRUMP_LOW = 0.35;
const SIDE_ACE = 0.75;
const SIDE_KING = 0.25;
const NT_ACE = 0.9;
const NT_KING = 0.5;
const NT_QUEEN = 0.2;

// choose_bid thresholds (five_hundred.py 280-289). The headroom and
// indication thresholds are exported because the Hard bot reuses the Medium
// indication rule verbatim and prunes rollout candidates by the same
// max-level formula (fh-7hw.3 decision).
const NULLA_LOWNESS = 8.6;
const NULLA_MAX_RANK = 11; // nothing above a jack
export const BID_HEADROOM = 2.5; // max_level = min(10, int(est + 2.5))
export const INDICATE_EST = 4.5;
// A partner indication promises est >= INDICATE_EST in that strain; the
// receiver credits a discounted share of it (fh-zpg), not the full promise,
// so a clearly stronger own-suit plan (raw edge > the bonus) still wins.
// Deliberately beyond the oracle: choose_bid never saw the auction at all.
export const PARTNER_INDICATION_BONUS = 2.0;

// consider_slam threshold (five_hundred.py 346)
const SLAM_EST = 8.0;

// Endgame aggression (fh-e52, no oracle counterpart: choose_bid never saw
// the game score). When the opponents end the game by winning this auction,
// passing concedes it, so a longshot contract that merely denies them the
// middle is worth stretching for. The stretch widens once they can also go
// out on defender tricks (10/trick), where owning the contract is the only
// remaining lever. Values below WIN_SCORE - CHEAPEST_CONTRACT leave the bid
// gate untouched, so play away from the endgame is byte-identical.
export const CHEAPEST_CONTRACT = 140; // 7S, the lowest winning bid's value
export const ENDGAME_HEADROOM = 1.5;
export const DESPERATE_HEADROOM = 2.5;
// Four defender tricks (40 pts) end the game from here even if we declare.
export const DESPERATE_SCORE = 460;

/** Extra bid headroom the game score justifies for the seat's side. */
export function endgameHeadroom(context: BidContext): number {
  const oppScore = context.scores[1 - (context.seat % 2)] as number;
  if (oppScore + CHEAPEST_CONTRACT < WIN_SCORE) return 0;
  return oppScore >= DESPERATE_SCORE ? DESPERATE_HEADROOM : ENDGAME_HEADROOM;
}

const ascending = (a: Card, b: Card): number => a - b;

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
   * Rough expected tricks with `strain` as trump (or NT). Oracle
   * _suit_strength (five_hundred.py 245-271); public so specs can pin the
   * weights and the sim harness can report estimates.
   */
  suitStrength(hand: readonly Card[], strain: number): number {
    const trump = strain !== NT ? strain : null;
    const sorted = [...hand].sort(ascending);
    let score = 0.0;
    if (sorted.includes(JOKER)) score += JOKER_TRICKS;
    for (const c of sorted) {
      if (c === JOKER) continue;
      const s = cardSuit(c) as number;
      const r = cardRank(c) as number;
      if (trump !== null) {
        if (r === 11 && (s === trump || s === SAME_COLOR[trump])) score += BOWER;
        else if (s === trump) score += r >= 12 ? TRUMP_HONOR : TRUMP_LOW;
        else if (r === 14) score += SIDE_ACE;
        else if (r === 13) score += SIDE_KING;
      } else {
        if (r === 14) score += NT_ACE;
        else if (r === 13) score += NT_KING;
        else if (r === 12) score += NT_QUEEN;
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
    const sorted = [...hand].sort(ascending);
    // Lose-all option: uniformly low hand, no joker, nothing above a jack.
    if (
      sorted.length > 0 &&
      !sorted.includes(JOKER) &&
      this.lowness(sorted) >= NULLA_LOWNESS &&
      Math.max(...sorted.map((c) => cardRank(c) as number)) <= NULLA_MAX_RANK
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
          ? own + PARTNER_INDICATION_BONUS
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
    const maxLevel = Math.min(10, Math.trunc(est + BID_HEADROOM + endgameHeadroom(context)));
    if (maxLevel < 7) {
      if (mayIndicate && ownEst >= INDICATE_EST && ownBestStrain < 4) {
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
    return this.suitStrength(hand15, contract.strain) >= SLAM_EST;
  }

  giveBestCard(hand: readonly Card[], contract: Bid): Card {
    return defaultGiveBestCard([...hand].sort(ascending), contract);
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
    if (isLoseAll(contract)) {
      // Duck with the biggest card that still loses; if forced to win,
      // shed the most dangerous card.
      const losers = sorted.filter((c) => cardPower(c, trump, ledSuit) < currentMax);
      const pool = losers.length > 0 ? losers : sorted;
      return firstMaxBy(pool, (c) =>
        cardPower(c, trump, ledSuit !== null ? ledSuit : cardSuit(c)),
      );
    }
    // Declarer-side lead in a trump contract (fh-n2n): draw trump while any
    // may still be live, then cash established side winners. The unseen set
    // is everything outside this hand and the played tricks, so it includes
    // the partner's trumps and any buried in the discards — the bot draws a
    // touch longer than a card-perfect reader would, never shorter.
    if (
      trump !== null &&
      ledSuit === null &&
      trickPlays.length === 0 &&
      seat % 2 === context.declarer % 2
    ) {
      const seen = new Set<Card>(hand);
      for (const t of context.tricks) for (const p of t.plays) seen.add(p.card);
      const unseen = DECK.filter((c) => !seen.has(c));
      const outTrumps = unseen.filter((c) => isTrumpCard(c, trump));
      const ownTrumps = sorted.filter((c) => isTrumpCard(c, trump));
      if (outTrumps.length > 0 && ownTrumps.length > 0) {
        const top = firstMaxBy(ownTrumps, (c) => cardPower(c, trump, null));
        const topPower = cardPower(top, trump, null);
        const boss = outTrumps.every((c) => cardPower(c, trump, null) < topPower);
        // Lead the boss trump, or from surplus length; never bleed the last
        // trumps into a war this hand cannot win.
        if (boss || (ownTrumps.length >= 2 && ownTrumps.length > outTrumps.length)) {
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
    const winners = sorted.filter((c) => cardPower(c, trump, ledSuit) > currentMax);
    if (winners.length > 0) return firstMinBy(winners, (c) => cardPower(c, trump, ledSuit));
    return firstMinBy(sorted, (c) => cardPower(c, trump, ledSuit));
  }
}
