/**
 * Bid values and the full bid ladder, including the nulla / double-nulla
 * placements: nulla sits directly above 7NT, double nulla between 10D and 10H.
 */

import { NT } from './cards.js';

export const NUM = 'NUM';
export const NULLA = 'NULLA';
export const DNULLA = 'DNULLA';
export const IND = 'IND';
export const PASS = 'PASS';

export type BidKind = typeof NUM | typeof NULLA | typeof DNULLA | typeof IND | typeof PASS;

export interface Bid {
  readonly kind: BidKind; // NUM / NULLA / DNULLA (winning), IND (6-level), PASS
  readonly level: number; // 7..10 for NUM, 6 for IND
  readonly strain: number; // 0..3 = trump suit, 4 = no-trump
}

export function bid(kind: BidKind, level = 0, strain = -1): Bid {
  return { kind, level, strain };
}

const STRAIN_NAMES = ['S', 'C', 'D', 'H', 'NT'];

export function bidName(b: Bid): string {
  if (b.kind === NUM) return `${b.level}${STRAIN_NAMES[b.strain]}`;
  if (b.kind === IND) return `6${STRAIN_NAMES[b.strain]} (indication)`;
  return b.kind;
}

function avondale(level: number, strain: number): number {
  return 40 + strain * 20 + (level - 6) * 100;
}

export function bidValue(b: Bid): number {
  if (b.kind === NUM) return avondale(b.level, b.strain);
  if (b.kind === NULLA) return 250;
  if (b.kind === DNULLA) return 500;
  return 0;
}

function buildLadder(): Bid[] {
  const ladder: Bid[] = [];
  for (let s = 0; s < 5; s++) ladder.push(bid(NUM, 7, s)); // 7S..7NT
  ladder.push(bid(NULLA)); // above all 7s, below all 8s
  for (const level of [8, 9]) {
    for (let s = 0; s < 5; s++) ladder.push(bid(NUM, level, s));
  }
  for (let s = 0; s < 3; s++) ladder.push(bid(NUM, 10, s)); // 10S, 10C, 10D
  ladder.push(bid(DNULLA)); // beaten only by 10H and 10NT
  ladder.push(bid(NUM, 10, 3)); // 10H
  ladder.push(bid(NUM, 10, NT)); // 10NT
  return ladder;
}

export const LADDER: readonly Bid[] = buildLadder();

/** JS lacks value-equal tuples, so the ladder index keys on `kind:level:strain`. */
export function bidKey(b: Bid): string {
  return `${b.kind}:${b.level}:${b.strain}`;
}

const LADDER_INDEX_MAP = new Map(LADDER.map((b, i) => [bidKey(b), i]));

/** Index of a bid in LADDER, or undefined if it is not a ladder bid. */
export function ladderIndex(b: Bid): number | undefined {
  return LADDER_INDEX_MAP.get(bidKey(b));
}

/** Trump suit index, or null for NT / nulla / double nulla. */
export function trumpOf(contract: Bid): number | null {
  if (contract.kind === NUM && contract.strain !== NT) return contract.strain;
  return null;
}

export function isLoseAll(contract: Bid): boolean {
  return contract.kind === NULLA || contract.kind === DNULLA;
}
