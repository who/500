// @vitest-environment jsdom

/**
 * M8 polish acceptance (fh-4s6.1), one spec per observable criterion:
 *   AC-1 a resolved trick stays highlighted ~1.5s before the next state
 *        applies to the display,
 *   AC-2 the last-trick peek shows the correct previous trick and winner,
 *   AC-3 the thinking indicator shows for acting bot seats after the reveal
 *        delay and never for humans.
 * The deeper linger/peek cases live in TrickArea.test.tsx.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { act } from 'react';
import { type RedactedView, type Trick, NUM, bid, makeCard } from '@five-hundred/engine';
import { TRICK_LINGER_MS } from '../store.ts';
import { THINKING_DELAY_MS } from './SeatBadge.tsx';
import {
  applyEvent,
  botSeatView,
  env,
  gameViewFixture,
  humanSeatView,
  installFakeLocalStorage,
  makeClient,
  renderApp,
  roomViewFixture,
} from '../screens/test-helpers.tsx';

beforeEach(() => {
  installFakeLocalStorage();
  history.replaceState(null, '', '/');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Two humans (Ana viewing, Ben right) and two bots across the top. */
const ROOM = roomViewFixture({
  started: true,
  hostSeat: 0,
  seats: [humanSeatView(0, 'Ana'), humanSeatView(1, 'Ben'), botSeatView(2), botSeatView(3)],
});

const TRICK: Trick = {
  leader: 1,
  ledSuit: 1,
  plays: [
    { seat: 1, card: makeCard(1, 14) }, // AC
    { seat: 2, card: makeCard(1, 5) }, // 5C
    { seat: 3, card: makeCard(1, 7) }, // 7C
    { seat: 0, card: makeCard(1, 13) }, // KC
  ],
  winner: 1,
};

function playView(overrides: Partial<RedactedView> = {}): RedactedView {
  return gameViewFixture(0, {
    phase: 'play',
    toAct: 0,
    contract: bid(NUM, 8, 3),
    declarer: 1,
    hand: [makeCard(2, 9)],
    handCounts: [1, 1, 1, 1],
    ...overrides,
  }).view;
}

it('AC-1: a resolved trick stays highlighted ~1.5s before the next state applies', () => {
  const client = makeClient();
  const app = renderApp(client);
  applyEvent(client, env(1, { t: 'roomState', room: ROOM }));
  applyEvent(
    client,
    env(2, {
      t: 'gameView',
      view: { view: playView({ trick: { leader: 1, ledSuit: 1, plays: TRICK.plays.slice(0, 3) } }) },
    }),
  );
  applyEvent(client, env(3, { t: 'trickResolved', trick: TRICK }));
  // The next state: the winner already led the following trick.
  applyEvent(
    client,
    env(4, {
      t: 'gameView',
      view: {
        view: playView({
          toAct: 2,
          trick: { leader: 1, ledSuit: 3, plays: [{ seat: 1, card: makeCard(3, 10) }] },
          lastTrick: TRICK,
          tricksPlayed: 1,
          sideTricks: [0, 1],
        }),
      },
    }),
  );

  const trickArea = app.getByTestId('trick-area');
  const winner = () => trickArea.querySelector('.trick-card[data-winner]') as HTMLElement | null;
  expect(trickArea.dataset.lingering).toBe('true');
  expect(trickArea.querySelectorAll('.trick-card')).toHaveLength(4);
  expect(winner()?.dataset.seat).toBe('1');

  act(() => {
    vi.advanceTimersByTime(TRICK_LINGER_MS - 1);
  });
  expect(winner()?.dataset.seat).toBe('1');

  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(trickArea.dataset.lingering).toBeUndefined();
  expect(trickArea.querySelectorAll('.trick-card')).toHaveLength(1);
  expect(winner()).toBeNull();
});

it('AC-2: the last-trick peek shows the correct previous trick with its winner', () => {
  const client = makeClient();
  const app = renderApp(client);
  applyEvent(client, env(1, { t: 'roomState', room: ROOM }));
  applyEvent(
    client,
    env(2, {
      t: 'gameView',
      view: {
        view: playView({
          toAct: 2,
          trick: { leader: 1, ledSuit: 3, plays: [{ seat: 1, card: makeCard(3, 10) }] },
          lastTrick: TRICK,
          tricksPlayed: 1,
        }),
      },
    }),
  );

  fireEvent.click(app.getByTestId('last-trick-toggle'));
  const popover = app.getByTestId('last-trick-popover');
  const entries = [...popover.querySelectorAll('li')];
  expect(entries.map((li) => li.dataset.seat)).toEqual(['1', '2', '3', '0']);
  expect((popover.querySelector('li[data-winner]') as HTMLElement).dataset.seat).toBe('1');
  expect(app.getByTestId('last-trick-winner').textContent).toBe('Won by Ben');
});

describe('AC-3: thinking indicator', () => {
  it('shows for an acting bot seat once the reveal delay passes', () => {
    const client = makeClient();
    const app = renderApp(client);
    applyEvent(client, env(1, { t: 'roomState', room: ROOM }));
    applyEvent(client, env(2, { t: 'gameView', view: { view: playView({ toAct: 2 }) } }));

    expect(app.queryByTestId('seat-thinking')).toBeNull(); // instant moves stay quiet
    act(() => {
      vi.advanceTimersByTime(THINKING_DELAY_MS);
    });
    const hint = app.getByTestId('seat-thinking');
    expect(hint.closest('.table-seat')?.getAttribute('data-seat')).toBe('2');
  });

  it('never shows for acting humans — the viewer or another seat', () => {
    const client = makeClient();
    const app = renderApp(client);
    applyEvent(client, env(1, { t: 'roomState', room: ROOM }));
    applyEvent(client, env(2, { t: 'gameView', view: { view: playView({ toAct: 1 }) } }));
    act(() => {
      vi.advanceTimersByTime(THINKING_DELAY_MS * 10);
    });
    expect(app.queryByTestId('seat-thinking')).toBeNull();

    applyEvent(client, env(3, { t: 'gameView', view: { view: playView({ toAct: 0 }) } }));
    act(() => {
      vi.advanceTimersByTime(THINKING_DELAY_MS * 10);
    });
    expect(app.queryByTestId('seat-thinking')).toBeNull();
  });

  it('clears when the turn moves from a bot to a human', () => {
    const client = makeClient();
    const app = renderApp(client);
    applyEvent(client, env(1, { t: 'roomState', room: ROOM }));
    applyEvent(client, env(2, { t: 'gameView', view: { view: playView({ toAct: 3 }) } }));
    act(() => {
      vi.advanceTimersByTime(THINKING_DELAY_MS);
    });
    expect(app.queryByTestId('seat-thinking')).not.toBeNull();

    applyEvent(client, env(3, { t: 'gameView', view: { view: playView({ toAct: 1 }) } }));
    expect(app.queryByTestId('seat-thinking')).toBeNull();
  });
});
