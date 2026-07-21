/**
 * Hand-end overlay (PRD section 6.1): contract result headline (slam/nulla
 * spelled out in words so the scoring is explainable), per-side deltas
 * including defender points, running totals, and the next-hand ready-up with
 * per-seat readiness ticks. Bots are always ready; humans tick as their
 * nextHand arrives via handReady events. The scrim is translucent and the
 * panel can be dismissed to peek at the final trick beneath — readiness
 * lives on the server, so peeking never loses the ready state.
 */

import { useState, type ReactNode } from 'react';
import { bidName, isLoseAll, type HandResult } from '@five-hundred/engine';
import type { RoomView } from '@five-hundred/protocol';

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

/** Result headline in words: made/set, with slam and nulla named outright. */
export function handEndHeadline(result: HandResult): string {
  const delta = signed(result.declarerDelta);
  if (isLoseAll(result.contract)) {
    const kind = result.contract.kind === 'DNULLA' ? 'Double nulla' : 'Nulla';
    return result.made ? `${kind} made: ${delta}` : `${kind} failed: ${delta}`;
  }
  if (result.slam) {
    return result.made ? `Slam made: ${delta}` : `Slam failed: ${delta}`;
  }
  const name = bidName(result.contract);
  return result.made ? `${name} made: ${delta}` : `${name} set: ${delta}`;
}

export interface HandEndOverlayProps {
  result: HandResult;
  /** Running game totals per side (index = seat % 2), post-hand. */
  scores: readonly [number, number];
  /** The viewer's seat, for Us/Them orientation. */
  seat: number;
  /** Seats currently ready for the next hand (humans that sent nextHand + bots). */
  readySeats: readonly number[];
  room: RoomView | null;
  names: readonly string[];
  onReady(): void;
}

export function HandEndOverlay(props: HandEndOverlayProps): ReactNode {
  const { result, scores, seat, readySeats, room, names } = props;
  const [peeking, setPeeking] = useState(false);
  const [sent, setSent] = useState(false);

  const us = seat % 2;
  const them = 1 - us;
  const declSide = result.declarer % 2;
  const deltas: readonly [number, number] =
    declSide === 0
      ? [result.declarerDelta, result.defenderDelta]
      : [result.defenderDelta, result.declarerDelta];

  function isReady(s: number): boolean {
    return room?.seats[s]?.occupant !== 'human' || readySeats.includes(s);
  }
  const meReady = sent || readySeats.includes(seat);
  const waiting = [0, 1, 2, 3].filter((s) => !isReady(s));

  function ready(): void {
    props.onReady();
    setSent(true);
  }

  if (peeking) {
    return (
      <div className="hand-end-peek" data-testid="hand-end-peek">
        <button type="button" onClick={() => setPeeking(false)}>
          Show results
        </button>
      </div>
    );
  }

  return (
    <div className="hand-end-scrim" data-testid="hand-end-overlay">
      <section className="hand-end-panel">
        <h2 data-testid="hand-end-headline">{handEndHeadline(result)}</h2>
        <p className="hand-end-contract" data-testid="hand-end-contract">
          {bidName(result.contract)} by {names[result.declarer]} — tricks{' '}
          {result.declarerSideTricks} to {result.defenderSideTricks}
          {isLoseAll(result.contract) && result.defenderDelta > 0 && (
            <span> (defenders score {result.defenderDelta} for tricks forced on the bidders)</span>
          )}
        </p>
        <dl className="hand-end-deltas">
          <div data-testid="hand-end-us">
            <dt>Us</dt>
            <dd>
              {signed(deltas[us])} — total {scores[us]}
            </dd>
          </div>
          <div data-testid="hand-end-them">
            <dt>Them</dt>
            <dd>
              {signed(deltas[them])} — total {scores[them]}
            </dd>
          </div>
        </dl>
        <ul className="hand-end-ready" data-testid="hand-end-ready">
          {[0, 1, 2, 3].map((s) => {
            const entry = room?.seats[s];
            const disconnected = entry?.occupant === 'human' && !entry.connected;
            return (
              <li key={s} data-seat={s} data-ready={isReady(s) ? 'true' : undefined}>
                <span className="ready-tick" aria-hidden="true">
                  {isReady(s) ? '✓' : '·'}
                </span>{' '}
                {names[s]}
                {disconnected && <em> (disconnected)</em>}
              </li>
            );
          })}
        </ul>
        {waiting.length > 0 && (
          <p className="hand-end-waiting" data-testid="hand-end-waiting">
            Waiting for {waiting.map((s) => names[s]).join(', ')}
          </p>
        )}
        <div className="hand-end-actions">
          <button type="button" data-testid="hand-end-ready-button" onClick={ready} disabled={meReady}>
            {meReady ? 'Ready — waiting for others' : 'Ready for next hand'}
          </button>
          <button type="button" data-testid="hand-end-peek-button" onClick={() => setPeeking(true)}>
            Peek at the table
          </button>
        </div>
      </section>
    </div>
  );
}
