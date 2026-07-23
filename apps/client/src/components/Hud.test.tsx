// @vitest-environment jsdom

/**
 * The HUD strip: the trick counter's two framings (numbered vs lose-all) and
 * the set state (fh-d2d) — which the HUD reads from the very predicate the
 * felt uses, so the two can never disagree.
 */

import { describe, expect, it } from 'vitest';
import { render, type RenderResult } from '@testing-library/react';
import { type RedactedView, NULLA, NUM, bid } from '@five-hundred/engine';
import { biddersAreSet } from '../lib/biddersSet.ts';
import { redactedViewFixture } from '../screens/test-helpers.tsx';
import { Hud } from './Hud.tsx';

const NAMES = ['Ana', 'AI Liam', 'AI Olivia', 'AI Noah'];

/** Mid-play view for the seat-0 viewer; 8H by the seat-1 bot. */
function playView(overrides: Partial<RedactedView> = {}): RedactedView {
  return redactedViewFixture(0, {
    phase: 'play',
    contract: bid(NUM, 8, 3),
    declarer: 1,
    ...overrides,
  });
}

function hud(overrides: Partial<RedactedView> = {}): RenderResult {
  return render(<Hud view={playView(overrides)} names={NAMES} />);
}

describe('trick counter', () => {
  it('shows both sides for a numbered contract', () => {
    const app = hud({ sideTricks: [2, 1] });
    expect(app.getByTestId('hud-tricks').textContent).toContain('Us 2 – Them 1');
  });

  it('counts tricks forced onto the bidders under a lose-all contract', () => {
    const app = hud({ contract: bid(NULLA), declarer: 0, sideTricks: [0, 3] });
    expect(app.getByTestId('hud-tricks').textContent).toContain('Tricks taken by bidders: 0');
  });
});

describe('set state', () => {
  it('stays clear while the bidders can still make it', () => {
    // 8H with two defender tricks: their ceiling is exactly 8.
    const app = hud({ sideTricks: [2, 0] });
    const tricks = app.getByTestId('hud-tricks');
    expect(tricks.dataset.biddersSet).toBeUndefined();
    expect(tricks.className).not.toContain('hud-set');
    expect(tricks.textContent).not.toContain('set');
  });

  it('marks the counter the moment the set is certain', () => {
    const app = hud({ sideTricks: [3, 0] });
    const tricks = app.getByTestId('hud-tricks');
    expect(tricks.dataset.biddersSet).toBe('true');
    expect(tricks.className).toContain('hud-set');
    expect(tricks.textContent).toContain('bidders set');
  });

  it('renders exactly what the shared predicate says (fh-d2d AC-5)', () => {
    const cases: (readonly [number, number])[] = [
      [0, 0],
      [2, 0],
      [3, 0],
      [5, 5],
    ];
    for (const sideTricks of cases) {
      const app = hud({ sideTricks });
      const shown = app.getByTestId('hud-tricks').dataset.biddersSet === 'true';
      expect(shown).toBe(biddersAreSet(playView({ sideTricks })));
      app.unmount();
    }
  });
});
