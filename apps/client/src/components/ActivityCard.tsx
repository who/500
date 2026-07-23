/**
 * ActivityCard — the "work is happening inside this box" border trace, taken
 * from https://github.com/who/ActivityCard (MIT, per its README) and vendored
 * as an adaptation rather than a dependency. Upstream is a 1.4k-line JSX
 * component carrying a fixed 300x180 wrapper, a hover scale, a pointer
 * cursor, six particle systems and a requestAnimationFrame loop that walks
 * particles around the outline; none of that suits a seat badge, which is
 * sized by its own contents and must not move, resize, or remount when the
 * turn changes hands (fh-8sw/fh-jbs). What is kept is the signature effect
 * and upstream's exact technique for it: a conic gradient whose origin angle
 * animates 0deg -> 360deg through a registered `<angle>` custom property, so
 * a bright head with a fading tail runs the outline (upstream's
 * `createBorderGradient` ramp and `borderTrace` keyframes, restated on this
 * app's accent tokens in App.css under `.activity-card`).
 *
 * Vendored means vendored: the whole effect is that CSS plus this file, so
 * the client stays self-contained and offline-buildable — nothing is fetched
 * at runtime.
 *
 * It renders as an overlay, never a wrapper. A wrapper would put the
 * decorated element at a new depth the moment thinking started, remounting
 * it and restarting the turn-highlight transition — the flash fh-jbs exists
 * to prevent. So the caller drops this in as one more absolutely positioned
 * child and pins it with `className`; this file only paints the ring.
 */

import { type ReactNode } from 'react';

export interface ActivityCardProps {
  /** Positioning rule for the overlay box (see `.seat-thinking`). */
  className: string;
  /** What the ring means, for screen readers — the ring itself is decor. */
  label: string;
  testId?: string;
}

export function ActivityCard(props: ActivityCardProps): ReactNode {
  return (
    <span className={props.className} role="status" data-testid={props.testId}>
      <span className="activity-card" aria-hidden="true" />
      <span className="activity-card-label">{props.label}</span>
    </span>
  );
}
