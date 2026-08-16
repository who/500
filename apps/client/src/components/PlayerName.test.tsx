// @vitest-environment jsdom

/**
 * fh-58m AC-2: the We/They side is derived viewer-relatively in exactly one
 * place — same parity as the viewer is us, the other parity them — and the
 * span carries only the display text, so converting a surface to PlayerName
 * can never change what its text assertions see.
 */

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { PlayerName, playerSide } from './PlayerName.tsx';

const NAMES = ['Ana', 'AI Liam', 'Cleo', 'AI Noah'];

describe('playerSide', () => {
  it('marks the viewer parity as us and the other as them, for every viewer', () => {
    for (const viewer of [0, 1, 2, 3]) {
      for (const seat of [0, 1, 2, 3]) {
        expect(playerSide(seat, viewer)).toBe(seat % 2 === viewer % 2 ? 'us' : 'them');
      }
    }
  });

  it('accepts a side index as the viewer — only parity matters', () => {
    expect(playerSide(2, 0)).toBe('us');
    expect(playerSide(3, 1)).toBe('us');
    expect(playerSide(2, 1)).toBe('them');
  });
});

describe('PlayerName', () => {
  it('renders names[seat] in a data-side span without changing the text', () => {
    const app = render(<PlayerName seat={3} viewerSeat={0} names={NAMES} />);
    const span = app.container.querySelector('.player-name') as HTMLElement;
    expect(span.textContent).toBe('AI Noah');
    expect(span.dataset['side']).toBe('them');
  });

  it('lets an explicit display string ("You") win over names[seat]', () => {
    const app = render(<PlayerName seat={2} viewerSeat={0} names={NAMES} name="You" />);
    const span = app.container.querySelector('.player-name') as HTMLElement;
    expect(span.textContent).toBe('You');
    expect(span.dataset['side']).toBe('us');
  });

  it('falls back to the seat label for a name-less seat, still tinted', () => {
    const app = render(<PlayerName seat={1} viewerSeat={0} />);
    const span = app.container.querySelector('.player-name') as HTMLElement;
    expect(span.textContent).toBe('Seat 2');
    expect(span.dataset['side']).toBe('them');
  });
});
