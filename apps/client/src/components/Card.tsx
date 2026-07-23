/**
 * SVG playing cards drawn in-repo (PRD default: clean drawn faces, red and
 * black suits, a distinct joker, no external asset pack). Faces keep a
 * near-white ground in both themes so the suit colors stay high-contrast;
 * sizing is left to CSS via the .card class.
 */

import type { ReactNode } from 'react';
import { type Card as CardId, JOKER, cardRank, cardSuit } from '@five-hundred/engine';

export const SUIT_GLYPHS = ['♠', '♣', '♦', '♥'] as const;

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
 * The foil sheen for a trump face (fh-wye). It paints over the card ground and
 * under the rank/pips, so trump reads as a moving holographic band while the
 * suit glyphs keep full contrast. Inert until the svg carries .card-trump —
 * CSS hides the group otherwise, so a non-trump face renders identically.
 *
 * The band is one repeating gradient tile 63 user units wide (the card's own
 * width) laid on an oversized rect, rotated inside a clip of the rounded card
 * outline. Sweeping the rect by exactly one tile therefore loops seamlessly
 * and never spills past the card's corners. Ids are per-card so two faces on
 * screen at once can't collide on url(#…).
 */
function FoilSheen(props: { card: CardId }): ReactNode {
  const gradientId = `foil-${props.card}`;
  const clipId = `foil-clip-${props.card}`;
  return (
    <>
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="63"
          y2="0"
          spreadMethod="repeat"
        >
          {/* White is the identity color under multiply, so the card body only
              tints where the iridescent part of the tile passes over it. */}
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.36" stopColor="#ffffff" />
          <stop offset="0.45" stopColor="#ffd36b" />
          <stop offset="0.53" stopColor="#ff8ec4" />
          <stop offset="0.61" stopColor="#7ec8ff" />
          <stop offset="0.69" stopColor="#8ff0c0" />
          <stop offset="0.78" stopColor="#ffffff" />
          <stop offset="1" stopColor="#ffffff" />
        </linearGradient>
        <clipPath id={clipId}>
          <rect x="1" y="1" width="62" height="88" rx="7" />
        </clipPath>
      </defs>
      <g className="card-foil" clipPath={`url(#${clipId})`}>
        <g transform="rotate(-24 32 45)">
          <rect
            className="card-foil-sheen"
            x="-100"
            y="-45"
            width="300"
            height="180"
            fill={`url(#${gradientId})`}
          />
        </g>
      </g>
    </>
  );
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
        <FoilSheen card={card} />
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
      <FoilSheen card={card} />
      <text x="7" y="20" className="card-corner-rank">
        {rank}
      </text>
      <text x="7" y="36" className="card-corner-suit">
        {glyph}
      </text>
      <text x="32" y="66" textAnchor="middle" className="card-pip">
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
