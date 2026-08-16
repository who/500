/**
 * Suit picker for leading the joker under no trump (PRD 6.2): in NT/nulla
 * hands the joker counts as every suit, so only its leader names one. The
 * popover opens from tapping the joker in the hand (see Hand); a suit button
 * submits the play with that jokerSuit, cancel returns to the hand with the
 * turn still open. Buttons stay finger-sized for touch play.
 */

import type { ReactNode } from 'react';
import { SuitGlyph } from './Card.tsx';

const SUIT_NAMES = ['Spades', 'Clubs', 'Diamonds', 'Hearts'] as const;

export function JokerSuitPicker(props: {
  onPick(suit: number): void;
  onCancel(): void;
}): ReactNode {
  return (
    <div
      className="joker-picker"
      role="dialog"
      aria-label="Name a suit for the joker"
      data-testid="joker-suit-picker"
    >
      <p className="joker-picker-title">Lead the joker as which suit?</p>
      <div className="joker-picker-suits">
        {SUIT_NAMES.map((name, suit) => (
          <button
            key={name}
            type="button"
            className={`joker-picker-suit ${suit >= 2 ? 'joker-picker-red' : 'joker-picker-black'}`}
            data-suit={suit}
            onClick={() => props.onPick(suit)}
          >
            <SuitGlyph suit={suit} className="joker-picker-glyph" aria-hidden />
            {name}
          </button>
        ))}
      </div>
      <button type="button" className="joker-picker-cancel" onClick={props.onCancel}>
        Cancel
      </button>
    </div>
  );
}
