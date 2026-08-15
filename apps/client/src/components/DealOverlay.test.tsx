// @vitest-environment jsdom

import { type ReactElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DealOverlay, MiddleFly } from './DealOverlay.tsx';

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

function mockTableRects(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('deal-overlay')) return rect(0, 0, 400, 400);
    if (this.classList.contains('my-seat')) return rect(150, 350, 80, 40);
    if (this.classList.contains('trick-area')) return rect(160, 160, 80, 80);
    if (this.getAttribute('data-seat') === '1') return rect(20, 180, 40, 40);
    if (this.getAttribute('data-seat') === '2') return rect(300, 20, 40, 40);
    if (this.getAttribute('data-seat') === '3') return rect(340, 180, 40, 40);
    return rect(0, 0, 0, 0);
  });
}

/** Table's sibling layout: opponent seats live in .game-table; the viewer is .my-seat after it. */
function tableLayout(overlay: ReactNode): ReactElement {
  return (
    <div data-screen="table">
      <div className="game-table">
        <div className="table-seat" data-seat="1" />
        <div className="table-seat" data-seat="2" />
        <div className="table-seat" data-seat="3" />
        <div className="trick-area" />
        {overlay}
      </div>
      <div className="my-seat" data-seat="0" />
    </div>
  );
}

describe('DealOverlay', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts flyers at .my-seat when the viewer is dealer', () => {
    mockTableRects();
    const app = render(
      tableLayout(
        <DealOverlay
          dealer={0}
          packets={[{ dest: { kind: 'seat', seat: 2 }, count: 1 }]}
          seed={1}
          onLand={() => undefined}
          onComplete={() => undefined}
        />,
      ),
    );

    const overlay = app.getByTestId('deal-overlay');
    const flyers = app.getAllByTestId('deal-flyer');
    expect(flyers).toHaveLength(1);
    const mine = app.container.querySelector('.my-seat');
    const dest = app.container.querySelector('.table-seat[data-seat="2"]');
    expect(mine).not.toBeNull();
    expect(dest).not.toBeNull();

    const o = overlay.getBoundingClientRect();
    const from = mine!.getBoundingClientRect();
    const to = dest!.getBoundingClientRect();
    const fromX = from.left + from.width / 2 - o.left;
    const fromY = from.top + from.height / 2 - o.top;
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    expect(dx).not.toBe(0);
    expect(dy).not.toBe(0);

    const flyer = flyers[0]!;
    expect(flyer.getAttribute('data-dest')).toBe('seat-2');
    expect(parseFloat(flyer.style.left)).toBe(fromX);
    expect(parseFloat(flyer.style.top)).toBe(fromY);
    expect(parseFloat(flyer.style.getPropertyValue('--dx'))).toBe(dx);
    expect(parseFloat(flyer.style.getPropertyValue('--dy'))).toBe(dy);
  });

  it('lands a packet destined for the viewer at .my-seat, not the overlay center', () => {
    mockTableRects();
    const app = render(
      tableLayout(
        <DealOverlay
          dealer={2}
          packets={[{ dest: { kind: 'seat', seat: 0 }, count: 1 }]}
          seed={1}
          onLand={() => undefined}
          onComplete={() => undefined}
        />,
      ),
    );

    const overlay = app.getByTestId('deal-overlay');
    const flyer = app.getByTestId('deal-flyer');
    const mine = app.container.querySelector('.my-seat');
    const origin = app.container.querySelector('.table-seat[data-seat="2"]');
    expect(mine).not.toBeNull();
    expect(origin).not.toBeNull();

    const o = overlay.getBoundingClientRect();
    const from = origin!.getBoundingClientRect();
    const to = mine!.getBoundingClientRect();
    const overlayCenterX = o.width / 2;
    const overlayCenterY = o.height / 2;
    const toX = to.left + to.width / 2 - o.left;
    const toY = to.top + to.height / 2 - o.top;
    expect(toX).not.toBe(overlayCenterX);
    expect(toY).not.toBe(overlayCenterY);

    expect(flyer.getAttribute('data-dest')).toBe('seat-0');
    expect(parseFloat(flyer.style.left)).toBe(from.left + from.width / 2 - o.left);
    expect(parseFloat(flyer.style.top)).toBe(from.top + from.height / 2 - o.top);
    expect(parseFloat(flyer.style.getPropertyValue('--dx'))).toBe(toX - (from.left + from.width / 2 - o.left));
    expect(parseFloat(flyer.style.getPropertyValue('--dy'))).toBe(toY - (from.top + from.height / 2 - o.top));
  });
});
