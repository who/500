// @vitest-environment jsdom

/**
 * fh-8sw acceptance: the whose-turn highlight must not move layout.
 *   AC-1/AC-2 a badge's box is invariant to turn state — jsdom computes
 *        styles but not geometry, so the specs assert the contract that
 *        fixes the box: the set of in-flow children never changes as
 *        acting/thinking/chips toggle (transient chrome is absolutely
 *        positioned; the chips strip is a fixed-size reserve rendered from
 *        the auction's first deal),
 *   AC-3 the highlight recolors through a CSS transition that shuts off
 *        under prefers-reduced-motion.
 * Styles are asserted against the real App.css (vitest stubs `import
 * x from '*.css'` to an empty string, so it is read off disk).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { act } from 'react';
import { type Bid, IND, NUM, PASS, bid } from '@five-hundred/engine';
import { SeatBadge, type SeatBadgeProps, THINKING_DELAY_MS } from './SeatBadge.tsx';

const CSS = readFileSync(join(import.meta.dirname, '../App.css'), 'utf8');

let style: HTMLStyleElement;
beforeEach(() => {
  vi.useFakeTimers();
  style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
});
afterEach(() => {
  style.remove();
  vi.useRealTimers();
});

function renderBadge(overrides: Partial<SeatBadgeProps> = {}) {
  const app = render(
    <SeatBadge
      name="Bot 2"
      isYou={false}
      isDealer={false}
      isActing={false}
      sittingOut={false}
      cardCount={10}
      showBacks
      bidHistory={[]}
      {...overrides}
    />,
  );
  const badge = app.container.querySelector('.seat-badge') as HTMLElement;
  return { app, badge };
}

/** The children that participate in layout — absolutely positioned chrome
 *  (thinking hint, sitting-out ribbon) is out of flow and cannot resize the
 *  badge, so the flow signature captures everything that sets its box. */
function flowSignature(badge: HTMLElement): string[] {
  return [...badge.children]
    .filter((el) => getComputedStyle(el).position !== 'absolute')
    .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
}

const BIDS: readonly Bid[] = [bid(IND, 6, 2), bid(NUM, 7, 0), bid(PASS)];

describe('turn handoff keeps the badge box invariant (AC-1/AC-2)', () => {
  it('acting, thinking, chips, and sitting-out states share the idle flow structure', () => {
    const base = flowSignature(renderBadge().badge);
    const states: Partial<SeatBadgeProps>[] = [
      { isActing: true },
      { isActing: true, thinking: true },
      { bidHistory: BIDS },
      { isActing: true, thinking: true, bidHistory: BIDS },
      { sittingOut: true, sittingOutReason: 'nulla' },
    ];
    for (const overrides of states) {
      const { app, badge } = renderBadge(overrides);
      // Let a pondering bot's hint pass its reveal delay before comparing.
      act(() => vi.advanceTimersByTime(THINKING_DELAY_MS));
      expect(flowSignature(badge)).toEqual(base);
      app.unmount();
    }
  });

  it('the revealed thinking hint and the ribbon are out of flow', () => {
    const { app, badge } = renderBadge({
      isActing: true,
      thinking: true,
      sittingOut: true,
      sittingOutReason: 'slam',
    });
    act(() => vi.advanceTimersByTime(THINKING_DELAY_MS));
    expect(getComputedStyle(app.getByTestId('seat-thinking')).position).toBe('absolute');
    const ribbon = badge.querySelector('.sitting-out-ribbon') as Element;
    expect(getComputedStyle(ribbon).position).toBe('absolute');
  });

  it('the chips strip is a fixed-size reserve, rendered even while empty', () => {
    const { app } = renderBadge({ bidHistory: [] });
    const strip = app.getByTestId('bid-history');
    expect(strip.querySelector('.bid-chip')).toBeNull();
    const stripStyle = getComputedStyle(strip);
    expect(stripStyle.width).toBe('9.5rem');
    expect(stripStyle.minHeight).toBe('1.15rem');

    // A one-row chip run exactly fills the reserve: each chip's border box
    // is pinned to the strip's min-height, so the first bid cannot grow it.
    const full = renderBadge({ bidHistory: BIDS });
    const chip = full.badge.querySelector('.bid-chip') as Element;
    expect(getComputedStyle(chip).height).toBe(stripStyle.minHeight);
  });

  it('no strip renders outside the auction (bidHistory undefined)', () => {
    const { app } = renderBadge({ bidHistory: undefined });
    expect(app.queryByTestId('bid-history')).toBeNull();
  });
});

describe('the highlight animates as recolor only (AC-3)', () => {
  it('.acting declares paint-only properties over an unchanged border width', () => {
    const idle = renderBadge();
    const acting = renderBadge({ isActing: true });
    expect(getComputedStyle(acting.badge).borderTopWidth).toBe(
      getComputedStyle(idle.badge).borderTopWidth,
    );
    const rule = /\.seat-badge\.acting \{([^}]*)\}/.exec(CSS);
    expect(rule).not.toBeNull();
    const declared = (rule as RegExpExecArray)[1]
      .split(';')
      .map((d) => d.split(':')[0]?.trim())
      .filter((d): d is string => d !== undefined && d !== '');
    expect(declared.length).toBeGreaterThan(0);
    for (const prop of declared) expect(['border-color', 'box-shadow']).toContain(prop);
  });

  it('transitions border-color/box-shadow and yields to prefers-reduced-motion', () => {
    const badgeRule = /\.seat-badge \{[^}]*\}/.exec(CSS)?.[0];
    expect(badgeRule).toMatch(/transition:[^;]*border-color/);
    expect(badgeRule).toMatch(/transition:[^;]*box-shadow/);
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{[^@]*?\.seat-badge \{[^}]*transition: none/.exec(
      CSS,
    );
    expect(reduced).not.toBeNull();
  });
});
