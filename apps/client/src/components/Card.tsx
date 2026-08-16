/**
 * SVG playing cards drawn in-repo (PRD default: clean drawn faces, red and
 * black suits, a distinct joker, no external asset pack). Faces keep a
 * near-white ground in both themes so the suit colors stay high-contrast;
 * sizing is left to CSS via the .card class.
 */

import type { ReactNode } from 'react';
import { type Card as CardId, JOKER, cardRank, cardSuit } from '@five-hundred/engine';

export const SUIT_GLYPHS = ['♠', '♣', '♦', '♥'] as const;

/** Hearts/diamonds are 2/3; spades/clubs 0/1. Shared by HTML chrome and SVG faces. */
export function suitTone(suit: number): 'suit-red' | 'suit-black' {
  return suit === 2 || suit === 3 ? 'suit-red' : 'suit-black';
}

/** Colored suit mark. NT stays letters and never goes through here. */
export function SuitGlyph(props: {
  suit: number;
  className?: string;
  'aria-hidden'?: boolean;
}): ReactNode {
  return (
    <span
      className={['suit-glyph', suitTone(props.suit), props.className].filter(Boolean).join(' ')}
      aria-hidden={props['aria-hidden']}
    >
      {SUIT_GLYPHS[props.suit]}
    </span>
  );
}

const RANK_LABELS: Readonly<Record<number, string>> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

export function rankLabel(card: CardId): string {
  const rank = cardRank(card);
  return rank === null ? '' : (RANK_LABELS[rank] ?? String(rank));
}

/** Human-readable card label, e.g. "A♥", "10♠", "Joker". */
export function cardLabel(card: CardId): string {
  if (card === JOKER) return 'Joker';
  return `${rankLabel(card)}${SUIT_GLYPHS[cardSuit(card) as number]}`;
}

function isRed(suit: number): boolean {
  return suit === 2 || suit === 3;
}

/**
 * One card face. The joker gets its own purple star design. `compact` is the
 * small-size variant (PRD 6.3): corner rank/suit grow to a legibility floor
 * and the mirrored bottom corner is dropped — CSS keys off .card-compact.
 */
export function CardFace(props: {
  card: CardId;
  className?: string;
  compact?: boolean;
}): ReactNode {
  const { card } = props;
  const classes = ['card', props.compact === true && 'card-compact', props.className]
    .filter(Boolean)
    .join(' ');
  if (card === JOKER) {
    return (
      <svg
        className={`${classes} card-joker`}
        viewBox="0 0 64 90"
        role="img"
        aria-label="Joker"
        data-card={card}
      >
        <rect x="1" y="1" width="62" height="88" rx="7" className="card-ground" />
        <text x="32" y="34" textAnchor="middle" className="card-joker-star">
          ★
        </text>
        <text x="32" y="62" textAnchor="middle" className="card-joker-word">
          JOKER
        </text>
      </svg>
    );
  }
  const suit = cardSuit(card) as number;
  const rank = rankLabel(card);
  const glyph = SUIT_GLYPHS[suit];
  return (
    <svg
      className={`${classes} ${isRed(suit) ? 'card-red' : 'card-black'}`}
      viewBox="0 0 64 90"
      role="img"
      aria-label={cardLabel(card)}
      data-card={card}
    >
      <rect x="1" y="1" width="62" height="88" rx="7" className="card-ground" />
      <text x="7" y="20" className="card-corner-rank">
        {rank}
      </text>
      <text x="7" y="36" className={`card-corner-suit suit-glyph ${suitTone(suit)}`}>
        {glyph}
      </text>
      <text x="32" y="66" textAnchor="middle" className={`card-pip suit-glyph ${suitTone(suit)}`}>
        {glyph}
      </text>
      <g transform="rotate(180 32 45)" className="card-corner-flip">
        <text x="7" y="20" className="card-corner-rank">
          {rank}
        </text>
      </g>
    </svg>
  );
}

/** A face-down card back (also used at mini size for opponents' counts). */
export function CardBack(props: { className?: string }): ReactNode {
  const classes = ['card', 'card-back', props.className].filter(Boolean).join(' ');
  return (
    <svg className={classes} viewBox="0 0 64 90" aria-hidden="true">
      <rect x="1" y="1" width="62" height="88" rx="7" className="card-ground" />
      <rect x="6" y="6" width="52" height="78" rx="4" className="card-back-panel" />
      <path
        className="card-back-weave"
        d="M6 20 58 6 M6 34 58 20 M6 48 58 34 M6 62 58 48 M6 76 58 62 M6 84 42 76"
      />
    </svg>
  );
}
