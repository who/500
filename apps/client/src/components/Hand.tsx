/**
 * The viewer's fanned hand, now interactive (PRD section 6.1): when the
 * server's actionRequest puts the play turn here, cards in the legal set play
 * on tap/click while the rest dim and block, each carrying its reason as a
 * hover title (desktop) and behind a long-press popover (touch). A submitted
 * play locks the whole hand until the next gameView so a double tap cannot
 * send two cards.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Card as CardId } from '@five-hundred/engine';
import { GENERIC_REASON } from '../lib/playLegality.ts';
import { CardFace, cardLabel } from './Card.tsx';

export const LONG_PRESS_MS = 450;

export interface HandProps {
  /** Cards already in display order (see sortHand). */
  cards: readonly CardId[];
  /** True when the viewer holds the play turn (interaction on). */
  active: boolean;
  /** Cards a tap may play; the rest dim while active. */
  legal: ReadonlySet<CardId>;
  /** Reason text per illegal card, shown on hover/long-press. */
  reasons: ReadonlyMap<CardId, string>;
  /** True between submitting a play and the next gameView. */
  locked: boolean;
  onPlay(card: CardId): void;
}

export function Hand(props: HandProps): ReactNode {
  // Illegal card whose reason the current long-press reveals.
  const [pressed, setPressed] = useState<CardId | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    },
    [],
  );

  const interactive = props.active && !props.locked;
  // Spread the fan across a fixed arc so 15/16-card exchange hands stay legible.
  const fanStep = props.cards.length > 1 ? Math.min(6, 40 / (props.cards.length - 1)) : 0;

  function beginPress(card: CardId): void {
    if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => setPressed(card), LONG_PRESS_MS);
  }

  function endPress(): void {
    if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    pressTimer.current = null;
    setPressed(null);
  }

  const pressedReason = pressed !== null ? props.reasons.get(pressed) : undefined;
  return (
    <div
      className="my-hand"
      data-testid="my-hand"
      data-locked={props.locked || undefined}
      aria-label="Your hand"
    >
      {pressedReason !== undefined && (
        <div className="card-reason" role="status" data-testid="card-reason">
          {pressedReason}
        </div>
      )}
      {props.cards.map((card, i) => {
        const playable = interactive && props.legal.has(card);
        const dimmed = interactive && !props.legal.has(card);
        const reason = dimmed ? (props.reasons.get(card) ?? GENERIC_REASON) : null;
        const classes = ['hand-card', playable && 'hand-card-playable', dimmed && 'hand-card-illegal']
          .filter(Boolean)
          .join(' ');
        return (
          <button
            key={card}
            type="button"
            className={classes}
            style={{ rotate: `${(i - (props.cards.length - 1) / 2) * fanStep}deg` }}
            title={reason ?? cardLabel(card)}
            aria-disabled={playable ? undefined : true}
            data-illegal={dimmed || undefined}
            onClick={() => {
              if (playable) props.onPlay(card);
            }}
            onTouchStart={dimmed ? () => beginPress(card) : undefined}
            onTouchEnd={endPress}
            onTouchMove={endPress}
            onTouchCancel={endPress}
          >
            <CardFace card={card} />
          </button>
        );
      })}
    </div>
  );
}
