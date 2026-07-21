/**
 * Card encoding and the 45-card deck.
 *
 * Cards are integers 0..44 using the identity mapping to the Python oracle:
 * `suit * 11 + (rank - 4)`, with the joker as 44. Suits in ladder order
 * (low -> high): 0=S, 1=C, 2=D, 3=H. Strain 4 is no-trump.
 */

export const SUITS = ['S', 'C', 'D', 'H'] as const;
export const NT = 4; // "strain" index for no-trump
export const RANKS: readonly number[] = Array.from({ length: 11 }, (_, i) => i + 4); // 4..10, J=11, Q=12, K=13, A=14
export const JOKER = 44;
export const N_CARDS = 45;
export const SAME_COLOR: Readonly<Record<number, number>> = { 0: 1, 1: 0, 2: 3, 3: 2 };

const RANK_NAMES: Readonly<Record<number, string>> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

export type Card = number;

export function makeCard(suit: number, rank: number): Card {
  return suit * 11 + (rank - 4);
}

export function cardSuit(c: Card): number | null {
  return c === JOKER ? null : Math.floor(c / 11);
}

export function cardRank(c: Card): number | null {
  return c === JOKER ? null : (c % 11) + 4;
}

export function cardName(c: Card): string {
  if (c === JOKER) return 'JOKER';
  const r = cardRank(c) as number;
  const s = cardSuit(c) as number;
  return `${RANK_NAMES[r] ?? String(r)}${SUITS[s]}`;
}

export const DECK: readonly Card[] = Array.from({ length: N_CARDS }, (_, i) => i);
