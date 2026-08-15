/**
 * Center of the table: the trick in progress, each played card offset
 * toward the seat that played it (relative to the viewer at the bottom).
 * Between tricks the just-completed trick stays up with its winner
 * highlighted: the store's linger freeze (`linger`) holds it for a beat even
 * when the next lead has already arrived underneath, and once the linger
 * releases the resolved-trick fallback keeps it visible until the next lead.
 * The linger's final beat sweeps the cards toward the winning seat (fh-rke)
 * so the viewer can follow who took the trick; after the sweep the fallback
 * holds the cleared end state instead of popping the cards back. A joker led
 * under no trump carries its declared suit as a chip on the card face
 * (PRD 6.2) — the named suit is exactly the trick's ledSuit.
 *
 * When the bidding side is set (fh-d2d) the felt takes a reddish border and
 * a banner names it; the caller owns the predicate (lib/biddersSet.ts) so the
 * HUD reads the same state.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { type CurrentTrickView, type Trick, JOKER } from '@five-hundred/engine';
import { trickPoseKey, trickRestPose } from '../lib/dealPattern.ts';
import { seatPosition } from '../lib/seating.ts';
import { trumpFaceClass } from '../lib/trumpMark.ts';
import { TRICK_LINGER_MS } from '../store.ts';
import { CardFace, SUIT_GLYPHS } from './Card.tsx';

const SUIT_NOUNS = ['spades', 'clubs', 'diamonds', 'hearts'] as const;

/**
 * How long the sweep-to-winner travel takes. It occupies the linger window's
 * final beat, so the release (and next-trick readiness) keeps today's timing.
 * Must match the transition duration on .trick-sweeping in App.css.
 */
export const TRICK_SWEEP_MS = 400;

function prefersReducedMotion(): boolean {
  // matchMedia can be absent outside browsers; no preference means animate.
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Identity of a completed trick across the store's two copies of it — the
 * linger freeze and view.lastTrick are distinct objects for the same trick.
 */
function trickKey(trick: Trick): string {
  return trick.plays.map((p) => `${p.seat}:${p.card}`).join('|');
}

export function TrickArea(props: {
  trick: CurrentTrickView | null;
  /** Last completed trick (view.lastTrick); shown while the next is unled. */
  lastTrick: Trick | null;
  /** Store linger freeze: overrides the live trick while non-null. */
  linger?: Trick | null;
  /** The viewer's seat, anchored at the bottom. */
  anchor: number;
  /** Trump suit of the contract; null for NT/nulla (joker chip contexts). */
  trump: number | null;
  /** The declaring side can no longer make it (lib/biddersSet.ts). */
  biddersSet?: boolean;
  /** Public view fields that seed a stable rest pose across linger remount. */
  handNumber?: number;
  tricksPlayed?: number;
}): ReactNode {
  const linger = props.linger ?? null;
  // Sweep machinery: TRICK_SWEEP_MS before the linger releases, the cards
  // start travelling toward the winner. `sweptKey` remembers which trick
  // swept so the post-release fallback renders it at the (cleared) end state
  // rather than popping the cards back. Reduced-motion viewers skip both and
  // keep the instant clear.
  const [sweeping, setSweeping] = useState(false);
  const [sweptKey, setSweptKey] = useState<string | null>(null);
  useEffect(() => {
    if (linger === null || prefersReducedMotion()) return undefined;
    const key = trickKey(linger);
    const timer = setTimeout(() => {
      setSweeping(true);
      setSweptKey(key);
    }, TRICK_LINGER_MS - TRICK_SWEEP_MS);
    return () => {
      clearTimeout(timer);
      setSweeping(false);
    };
  }, [linger]);
  const inProgress = linger === null && props.trick !== null && props.trick.plays.length > 0;
  const resolved = linger ?? (!inProgress && props.lastTrick !== null ? props.lastTrick : null);
  const plays = inProgress ? (props.trick?.plays ?? []) : (resolved?.plays ?? []);
  const winner = resolved?.winner ?? null;
  const leader = inProgress ? (props.trick?.leader ?? null) : (resolved?.leader ?? null);
  const ledSuit = inProgress ? (props.trick?.ledSuit ?? null) : (resolved?.ledSuit ?? null);
  const sweepingNow = sweeping && linger !== null;
  const swept =
    linger === null && !inProgress && resolved !== null && sweptKey === trickKey(resolved);
  const sweepTarget =
    (sweepingNow || swept) && winner !== null ? seatPosition(winner, props.anchor) : null;
  const biddersSet = props.biddersSet === true;
  const poseKey = trickPoseKey(props.handNumber ?? 0, props.tricksPlayed ?? 0, inProgress);
  const areaClasses = [
    'trick-area',
    sweepingNow && 'trick-sweeping',
    swept && 'trick-swept',
    sweepTarget !== null && `sweep-to-${sweepTarget}`,
    biddersSet && 'bidders-set',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <>
      <div
        className={areaClasses}
        data-testid="trick-area"
        data-lingering={linger !== null || undefined}
        data-sweeping={sweepingNow || undefined}
        data-sweep-target={sweepTarget ?? undefined}
        data-bidders-set={biddersSet || undefined}
      >
        {plays.map((play) => {
          const won = play.seat === winner;
          // Only a LED joker under no trump named a suit; played to a led
          // trick it silently follows, and in trump contracts it is trump.
          const declared =
            play.card === JOKER && play.seat === leader && props.trump === null && ledSuit !== null
              ? ledSuit
              : null;
          const classes = [
            'trick-card',
            `trick-${seatPosition(play.seat, props.anchor)}`,
            won && 'trick-winner',
          ]
            .filter(Boolean)
            .join(' ');
          const pose = trickRestPose(play.seat, play.card, poseKey);
          const poseStyle = {
            ['--rest-rot']: `${pose.rotate}deg`,
            ['--rest-x']: `${pose.x}px`,
            ['--rest-y']: `${pose.y}px`,
          } as CSSProperties;
          return (
            <div
              key={play.seat}
              className={classes}
              data-seat={play.seat}
              data-winner={won || undefined}
              style={poseStyle}
            >
              <CardFace card={play.card} className={trumpFaceClass(play.card, props.trump)} />
              {declared !== null && (
                <span
                  className="joker-declares"
                  data-testid="joker-declares"
                  data-suit={declared}
                  title={`Joker declares ${SUIT_NOUNS[declared]}`}
                >
                  declares {SUIT_GLYPHS[declared]}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {biddersSet && (
        <div className="bidders-set-banner" role="status" data-testid="bidders-set-banner">
          Bidders have been set!
        </div>
      )}
    </>
  );
}
