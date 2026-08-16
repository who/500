// @vitest-environment jsdom

/**
 * Responsive/variant spec (PRD 6.3 / AC-2, AC-3). jsdom does no layout, so
 * the observable surface is class/variant switching: the compact card face
 * activates exactly on oversized (>10 card) fans, and the exchange hand
 * carries the .exchange-hand hook the sub-500px wrap rule keys off. The
 * pixel-level pass at 375/768/1280 is the manual checklist on the issue.
 */

import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DNULLA, bid } from '@five-hundred/engine';
import { ExchangePicker } from './components/ExchangePicker.tsx';
import { GiveCardPicker } from './components/GiveCardPicker.tsx';
import { Hand } from './components/Hand.tsx';
import {
  applyEvent,
  env,
  gameViewFixture,
  installFakeLocalStorage,
  makeClient,
  renderApp,
  roomViewFixture,
} from './screens/test-helpers.tsx';

beforeEach(() => {
  installFakeLocalStorage();
  history.replaceState(null, '', '/');
});

/** n distinct valid card ids (the fixtures use raw ints the same way). */
const cards = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

function handProps(n: number) {
  return {
    cards: cards(n),
    active: false,
    legal: new Set<number>(),
    needsSuit: new Set<number>(),
    reasons: new Map<number, string>(),
    locked: false,
    onPlay: () => {},
    onNeedsSuit: () => {},
  };
}

describe('compact card face variant (AC-3)', () => {
  it('activates on a 15-card exchange hand', () => {
    const app = render(<Hand {...handProps(15)} />);
    const faces = app.container.querySelectorAll('svg.card');
    expect(faces).toHaveLength(15);
    for (const face of faces) expect(face.classList.contains('card-compact')).toBe(true);
  });

  it('stays off for a regular 10-card hand', () => {
    const app = render(<Hand {...handProps(10)} />);
    const faces = app.container.querySelectorAll('svg.card');
    expect(faces).toHaveLength(10);
    for (const face of faces) expect(face.classList.contains('card-compact')).toBe(false);
  });

  it('activates in the 15-card discard picker and 16-card slam variant', () => {
    for (const n of [15, 16]) {
      const app = render(
        <ExchangePicker cards={cards(n)} locked={false} onConfirm={() => {}} />,
      );
      const faces = app.container.querySelectorAll('svg.card');
      expect(faces).toHaveLength(n);
      for (const face of faces) expect(face.classList.contains('card-compact')).toBe(true);
      app.unmount();
    }
  });

  it('stays off in the 10-card give-card picker', () => {
    const app = render(
      <GiveCardPicker cards={cards(10)} trump={null} locked={false} onGive={() => {}} />,
    );
    for (const face of app.container.querySelectorAll('svg.card')) {
      expect(face.classList.contains('card-compact')).toBe(false);
    }
  });

  it('keeps the mirrored bottom corner only on the full-size face', () => {
    const compact = render(<Hand {...handProps(15)} />);
    // The flip corner stays in the DOM; .card-compact hides it via CSS.
    expect(compact.container.querySelector('.card-compact .card-corner-flip')).not.toBeNull();
    compact.unmount();
    const full = render(<Hand {...handProps(10)} />);
    expect(full.container.querySelector('.card-corner-flip')).not.toBeNull();
    expect(full.container.querySelector('.card-compact')).toBeNull();
  });
});

describe('exchange fan wrap hook (AC-2)', () => {
  it('the Table exchange state renders the 15 cards inside .exchange-hand', () => {
    // The <500px wrap rule targets .exchange-hand; assert the worst-case fan
    // (15-card dnulla pass-through) actually renders inside that container.
    const client = makeClient();
    const app = renderApp(client);
    applyEvent(client, env(0, { t: 'roomState', room: roomViewFixture({ started: true }) }));
    applyEvent(
      client,
      env(1, {
        t: 'gameView',
        view: gameViewFixture(0, {
          phase: 'middleExchange',
          contract: bid(DNULLA),
          declarer: 2,
          toAct: 0,
          hand: cards(15),
          handCounts: [15, 10, 10, 10],
          middleCount: 0,
        }),
      }),
    );
    const picker = app.getByTestId('exchange-picker');
    const fan = picker.querySelector('.exchange-hand');
    expect(fan).not.toBeNull();
    expect(fan?.querySelectorAll('.card-compact')).toHaveLength(15);
  });

  it('the plain play hand does not opt into the wrap rule', () => {
    const app = render(<Hand {...handProps(10)} />);
    expect(app.container.querySelector('.my-hand')).not.toBeNull();
    expect(app.container.querySelector('.exchange-hand')).toBeNull();
  });
});
