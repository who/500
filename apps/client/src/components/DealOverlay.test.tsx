// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MiddleFly } from './DealOverlay.tsx';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON() {
      return this;
    },
  } as DOMRect;
}

describe('MiddleFly', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('measures after layout so --dx/--dy point at the declarer seat', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('deal-overlay')) return rect(0, 0, 400, 400);
      if (this.classList.contains('trick-area')) return rect(100, 180, 80, 80);
      if (this.getAttribute('data-seat') === '2') return rect(300, 20, 40, 40);
      return rect(0, 0, 0, 0);
    });

    const app = render(
      <div className="game-table">
        <div data-seat="2" />
        <div className="trick-area" />
        <MiddleFly declarer={2} seed={1} onComplete={() => undefined} />
      </div>,
    );

    const overlay = app.getByTestId('middle-fly');
    const flyers = app.getAllByTestId('deal-flyer');
    expect(flyers).toHaveLength(5);
    const seat = app.container.querySelector('[data-seat="2"]');
    const felt = app.container.querySelector('.trick-area');
    expect(seat).not.toBeNull();
    expect(felt).not.toBeNull();

    const o = overlay.getBoundingClientRect();
    const s = seat!.getBoundingClientRect();
    const f = felt!.getBoundingClientRect();
    const towardX = s.left + s.width / 2 - (f.left + f.width / 2);
    const towardY = s.top + s.height / 2 - (f.top + f.height / 2);
    expect(towardX).not.toBe(0);
    expect(towardY).not.toBe(0);

    for (const flyer of flyers) {
      expect(flyer.getAttribute('data-dest')).toBe('seat-2');
      const dx = parseFloat(flyer.style.getPropertyValue('--dx'));
      const dy = parseFloat(flyer.style.getPropertyValue('--dy'));
      expect(dx).toBe(towardX);
      expect(dy).toBe(towardY);
      expect(Number.isFinite(dx)).toBe(true);
      expect(dx).not.toBe(0);
      expect(dy).not.toBe(0);
      // Overlay origin is (0,0); start left/top should be the felt center.
      expect(parseFloat(flyer.style.left)).toBe(f.left + f.width / 2 - o.left);
      expect(parseFloat(flyer.style.top)).toBe(f.top + f.height / 2 - o.top);
    }
  });
});
