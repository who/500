/**
 * Deal packet flights and the post-toast middle-to-declarer fly (fh-8t1).
 * CardBacks travel from the dealer badge to each seat or the felt middle;
 * reduced-motion callers never mount this overlay (the reducer snaps).
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { cardJitter, type Packet } from '../lib/dealPattern.ts';
import { prefersReducedMotion } from '../lib/dealChoreography.ts';
import { CardBack } from './Card.tsx';

export const PACKET_FLIGHT_MS = 280;
export const PACKET_GAP_MS = 70;
export const PICKUP_FLIGHT_MS = 420;

interface Point {
  x: number;
  y: number;
}

function searchRoot(overlay: HTMLElement): HTMLElement {
  return overlay.closest('.game-table') ?? overlay.closest('[data-screen="table"]') ?? overlay;
}

function centerOf(overlay: HTMLElement, selector: string): Point {
  const box = overlay.getBoundingClientRect();
  const el = searchRoot(overlay).querySelector(selector);
  if (el === null) return { x: box.width / 2, y: box.height / 2 };
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2 - box.left, y: r.top + r.height / 2 - box.top };
}

function flyerStyle(from: Point, to: Point, jitter: { rotate: number; delay: number; arc: number }, dur: number): CSSProperties {
  return {
    left: from.x,
    top: from.y,
    ['--dx' as string]: `${to.x - from.x}px`,
    ['--dy' as string]: `${to.y - from.y}px`,
    ['--rot' as string]: `${jitter.rotate}deg`,
    ['--arc' as string]: `${jitter.arc}px`,
    ['--dur' as string]: `${dur}ms`,
    ['--delay' as string]: `${jitter.delay}ms`,
  };
}

/** Measure seat/felt centers after the overlay is in the tree; first paint has no box. */
function useMeasuredPath(
  overlayRef: RefObject<HTMLDivElement | null>,
  fromSel: string | null,
  toSel: string | null,
): { from: Point; to: Point } | null {
  const [path, setPath] = useState<{ from: Point; to: Point } | null>(null);
  useLayoutEffect(() => {
    const root = overlayRef.current;
    if (root === null || fromSel === null || toSel === null) {
      setPath(null);
      return;
    }
    setPath({ from: centerOf(root, fromSel), to: centerOf(root, toSel) });
  }, [overlayRef, fromSel, toSel]);
  return path;
}

export function MiddlePile(props: { count: number }): ReactNode {
  if (props.count <= 0) return null;
  return (
    <div className="middle-pile" data-testid="middle-pile" aria-label={`${props.count} cards in the middle`}>
      {Array.from({ length: props.count }, (_, i) => (
        <div
          key={i}
          className="middle-pile-card"
          style={{
            transform: `translate(${i * 3}px, ${i * -2}px) rotate(${(i - 2) * 3}deg)`,
          }}
        >
          <CardBack />
        </div>
      ))}
    </div>
  );
}

export function DealOverlay(props: {
  dealer: number;
  packets: readonly Packet[];
  seed: number;
  onLand(packet: Packet): void;
  onComplete(): void;
}): ReactNode {
  const rootRef = useRef<HTMLDivElement>(null);
  const [flying, setFlying] = useState<{ packet: Packet; index: number } | null>(null);
  const onLand = useRef(props.onLand);
  const onComplete = useRef(props.onComplete);
  onLand.current = props.onLand;
  onComplete.current = props.onComplete;
  const destSel =
    flying === null
      ? null
      : flying.packet.dest.kind === 'middle'
        ? '.deal-felt, .middle-pile, .trick-area, .bid-panel'
        : `[data-seat="${flying.packet.dest.seat}"]`;
  const path = useMeasuredPath(rootRef, flying === null ? null : `[data-seat="${props.dealer}"]`, destSel);

  useEffect(() => {
    if (prefersReducedMotion()) {
      onComplete.current();
      return undefined;
    }
    let cancelled = false;
    let i = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function play(): void {
      if (cancelled) return;
      if (i >= props.packets.length) {
        setFlying(null);
        onComplete.current();
        return;
      }
      const packet = props.packets[i] as Packet;
      setFlying({ packet, index: i });
      let extra = 0;
      for (let c = 0; c < packet.count; c++) {
        extra = Math.max(extra, cardJitter(props.seed, i, c).delay);
      }
      timer = setTimeout(() => {
        onLand.current(packet);
        i += 1;
        timer = setTimeout(play, PACKET_GAP_MS);
      }, PACKET_FLIGHT_MS + extra);
    }
    play();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [props.packets, props.seed]);

  return (
    <div ref={rootRef} className="deal-overlay" data-testid="deal-overlay" aria-hidden="true">
      {flying !== null &&
        path !== null &&
        Array.from({ length: flying.packet.count }, (_, c) => {
          const jitter = cardJitter(props.seed, flying.index, c);
          return (
            <div
              key={`${flying.index}-${c}`}
              className="deal-flyer"
              data-testid="deal-flyer"
              data-dest={flying.packet.dest.kind === 'seat' ? `seat-${flying.packet.dest.seat}` : 'middle'}
              style={flyerStyle(path.from, path.to, jitter, PACKET_FLIGHT_MS)}
            >
              <CardBack />
            </div>
          );
        })}
    </div>
  );
}

export function MiddleFly(props: {
  declarer: number;
  seed: number;
  onComplete(): void;
}): ReactNode {
  const rootRef = useRef<HTMLDivElement>(null);
  const onComplete = useRef(props.onComplete);
  onComplete.current = props.onComplete;
  const path = useMeasuredPath(
    rootRef,
    '.trick-area, .bid-panel, .deal-felt, .middle-pile',
    `[data-seat="${props.declarer}"]`,
  );

  useEffect(() => {
    if (prefersReducedMotion()) {
      onComplete.current();
      return undefined;
    }
    const timer = setTimeout(() => onComplete.current(), PICKUP_FLIGHT_MS + 40);
    return () => {
      clearTimeout(timer);
    };
  }, [props.declarer, props.seed]);

  return (
    <div ref={rootRef} className="deal-overlay" data-testid="middle-fly" aria-hidden="true">
      {path !== null &&
        Array.from({ length: 5 }, (_, c) => {
          const jitter = cardJitter(props.seed, 99, c);
          return (
            <div
              key={c}
              className="deal-flyer deal-flyer-pickup"
              data-testid="deal-flyer"
              data-dest={`seat-${props.declarer}`}
              style={flyerStyle(path.from, path.to, jitter, PICKUP_FLIGHT_MS)}
            >
              <CardBack />
            </div>
          );
        })}
    </div>
  );
}
