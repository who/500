/**
 * Slam partner's surrender picker (PRD 6.2, 3.3): after the declarer slams,
 * the partner gives up one card. The strongest card arrives pre-selected —
 * rated by the engine's cardPower under the contract trump with each card's
 * own suit as led, mirroring the bots' default give-best-card — but every
 * card stays tappable, so the choice is free. Confirm submits giveCard.
 */

import { useState, type ReactNode } from 'react';
import { type Card as CardId, cardPower, cardSuit } from '@five-hundred/engine';
import { CardFace, cardLabel } from './Card.tsx';

/**
 * Strongest card by trick power, each card rated as if its own suit were led
 * (plain suit cards rank by 1000 + rank; the joker always tops). Pure mirror
 * of the Python give_best_card default. Null only for an empty hand.
 */
export function strongestCard(cards: readonly CardId[], trump: number | null): CardId | null {
  let best: CardId | null = null;
  let bestPower = -1;
  for (const c of cards) {
    const power = cardPower(c, trump, cardSuit(c));
    if (power > bestPower) {
      best = c;
      bestPower = power;
    }
  }
  return best;
}

export interface GiveCardPickerProps {
  /** Held cards in display order (see sortHand). */
  cards: readonly CardId[];
  /** Contract trump suit (null for NT), for the strongest-card suggestion. */
  trump: number | null;
  /** True between submitting the card and the next gameView. */
  locked: boolean;
  onGive(card: CardId): void;
}

export function GiveCardPicker(props: GiveCardPickerProps): ReactNode {
  const suggested = strongestCard(props.cards, props.trump);
  // The pick, pre-seeded with the suggestion. Local-only, like the exchange.
  const [selected, setSelected] = useState<CardId | null>(suggested);
  const chosen = selected !== null && props.cards.includes(selected) ? selected : null;

  // Same fixed-arc fan as Hand so the cards stay legible at phone width.
  const fanStep = props.cards.length > 1 ? Math.min(6, 40 / (props.cards.length - 1)) : 0;
  // Same compact-face rule as Hand/ExchangePicker (only oversized fans hit it).
  const compact = props.cards.length > 10;

  return (
    <div
      className="exchange-picker give-card-picker"
      data-testid="give-card-picker"
      data-locked={props.locked || undefined}
    >
      <div className="exchange-count" role="status" data-testid="give-card-status">
        Your partner declared a slam — give them one card. Strongest suggested
        {suggested !== null && `: ${cardLabel(suggested)}`}.
      </div>
      <div className="my-hand exchange-hand" aria-label="Choose the card to give">
        {props.cards.map((card, i) => {
          const marked = card === chosen;
          const classes = ['hand-card', 'exchange-card', marked && 'give-card-selected']
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={card}
              type="button"
              className={classes}
              style={{ rotate: `${(i - (props.cards.length - 1) / 2) * fanStep}deg` }}
              title={cardLabel(card)}
              aria-pressed={marked}
              data-give={marked || undefined}
              onClick={() => {
                if (!props.locked) setSelected(card);
              }}
            >
              <CardFace card={card} compact={compact} />
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="primary"
        data-testid="give-card-confirm"
        disabled={chosen === null || props.locked}
        onClick={() => {
          if (chosen !== null && !props.locked) props.onGive(chosen);
        }}
      >
        Give {chosen === null ? 'a card' : cardLabel(chosen)}
      </button>
    </div>
  );
}
