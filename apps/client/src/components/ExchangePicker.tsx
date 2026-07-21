/**
 * Middle-exchange discard picker (PRD 6.1): the declarer's 15 picked-up cards
 * fanned like the play hand, tap toggling a discard mark on each. Selection
 * marks the discards — "picks up the middle, then discards 5" is the house
 * mental model — and confirm stays disabled until exactly the required count
 * is marked, then submits the keeps (held minus marked) to match the engine's
 * discardKeeps action shape. `maxKeep` covers the 16-card slam variant the M6
 * leaf wires up (still keep 10, discard 6).
 */

import { useState, type ReactNode } from 'react';
import type { Card as CardId } from '@five-hundred/engine';
import { CardFace, cardLabel } from './Card.tsx';

export interface ExchangePickerProps {
  /** Held cards in display order (see sortHand). */
  cards: readonly CardId[];
  /** Cards to keep after the discard; defaults to the standard 10. */
  maxKeep?: number;
  /**
   * Lead-in for the status line; defaults to the declarer pickup copy. The
   * dnulla pass-through mounts the same picker for the partner with "Your
   * partner passed you 5 cards" (the 5 arrive unmarked — which cards they
   * were is declarer signaling the rules doc forbids).
   */
  intro?: string;
  /** True between submitting the discard and the next gameView. */
  locked: boolean;
  onConfirm(keeps: readonly CardId[]): void;
}

export function ExchangePicker(props: ExchangePickerProps): ReactNode {
  const maxKeep = props.maxKeep ?? 10;
  const target = Math.max(0, props.cards.length - maxKeep);
  // Marked discards. Local-only: a reload or reconnect starts the pick over.
  const [selected, setSelected] = useState<ReadonlySet<CardId>>(new Set());
  const chosen = props.cards.filter((c) => selected.has(c));
  const ready = chosen.length === target;

  function toggle(card: CardId): void {
    if (props.locked) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(card)) next.add(card);
      return next;
    });
  }

  function confirm(): void {
    if (!ready || props.locked) return;
    props.onConfirm(props.cards.filter((c) => !selected.has(c)));
  }

  // Same fixed-arc fan as Hand so the 15/16 cards stay legible at phone width.
  const fanStep = props.cards.length > 1 ? Math.min(6, 40 / (props.cards.length - 1)) : 0;

  return (
    <div
      className="exchange-picker"
      data-testid="exchange-picker"
      data-locked={props.locked || undefined}
    >
      <div className="exchange-count" role="status" data-testid="exchange-count">
        {props.intro ?? 'You picked up the middle'} — tap {target} cards to discard. {chosen.length}
        /{target} selected
      </div>
      <div className="my-hand exchange-hand" aria-label="Choose your discards">
        {props.cards.map((card, i) => {
          const marked = selected.has(card);
          const classes = ['hand-card', 'exchange-card', marked && 'exchange-card-discard']
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
              data-discard={marked || undefined}
              onClick={() => toggle(card)}
            >
              <CardFace card={card} />
              {marked && (
                <span className="discard-mark" aria-hidden="true">
                  ✕
                </span>
              )}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="primary"
        data-testid="exchange-confirm"
        disabled={!ready || props.locked}
        onClick={confirm}
      >
        Discard {target}
      </button>
    </div>
  );
}
