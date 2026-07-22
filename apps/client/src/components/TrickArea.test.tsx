// @vitest-environment jsdom

/**
 * M8 trick-flow polish (fh-4s6.1): the linger state machine — a resolved
 * trick stays frozen with its winner highlighted for TRICK_LINGER_MS while
 * views keep applying underneath — and the last-trick peek popover. Driven
 * through the real store + Table so the specs cover exactly what the server
 * event stream produces: trickResolved, then the fresh view, then whatever
 * the bots manage inside the window.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, type RenderResult } from '@testing-library/react';
import { act } from 'react';
import { type RedactedView, type Trick, NUM, bid, makeCard } from '@five-hundred/engine';
import { TRICK_LINGER_MS } from '../store.ts';
import { TRICK_SWEEP_MS } from './TrickArea.tsx';
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
  type TestClient,
} from '../screens/test-helpers.tsx';

beforeEach(() => {
  installFakeLocalStorage();
  history.replaceState(null, '', '/');
});

/** Viewer Ana at seat 0 against three bots (Bot 2 / Bot 3 / Bot 4). */
const ROOM = roomViewFixture({
  started: true,
  hostSeat: 0,
  seats: [humanSeatView(0, 'Ana'), botSeatView(1), botSeatView(2), botSeatView(3)],
});

/** Clubs trick led by seat 1 and won by its A♣; the viewer followed last. */
const T1: Trick = {
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

/** Hearts trick the bots race through inside T1's linger; seat 3 wins. */
const T2: Trick = {
  leader: 1,
  ledSuit: 3,
  plays: [
    { seat: 1, card: makeCard(3, 10) }, // TH
    { seat: 2, card: makeCard(3, 5) }, // 5H
    { seat: 3, card: makeCard(3, 14) }, // AH
    { seat: 0, card: makeCard(2, 9) }, // 9D sluff
  ],
  winner: 3,
};

/** Mid-play view for the viewer; override the trick bits per spec. */
function playView(overrides: Partial<RedactedView> = {}): RedactedView {
  return gameViewFixture(0, {
    phase: 'play',
    toAct: 0,
    contract: bid(NUM, 8, 3), // 8H by the seat-1 bot
    declarer: 1,
    hand: [makeCard(1, 13), makeCard(2, 9)],
    handCounts: [2, 2, 2, 2],
    ...overrides,
  }).view;
}

/**
 * Room + mid-trick view, then T1 resolves and its fresh view arrives —
 * the store is lingering on T1 when this returns (seqs 1-4 consumed).
 */
function startLinger(client: TestClient, winner = 1): RenderResult {
  const app = renderApp(client);
  const trick: Trick = { ...T1, winner };
  applyEvent(client, env(1, { t: 'roomState', room: ROOM }));
  applyEvent(
    client,
    env(2, {
      t: 'gameView',
      view: { view: playView({ trick: { leader: 1, ledSuit: 1, plays: T1.plays.slice(0, 3) } }) },
    }),
  );
  applyEvent(client, env(3, { t: 'trickResolved', trick }));
  applyEvent(
    client,
    env(4, {
      t: 'gameView',
      view: {
        view: playView({
          toAct: winner,
          hand: [makeCard(2, 9)],
          handCounts: [1, 1, 1, 1],
          trick: { leader: winner, ledSuit: null, plays: [] },
          lastTrick: trick,
          tricksPlayed: 1,
          sideTricks: winner % 2 === 0 ? [1, 0] : [0, 1],
        }),
      },
    }),
  );
  return app;
}

function shownSeats(app: RenderResult): string[] {
  return [...app.getByTestId('trick-area').querySelectorAll('.trick-card')].map(
    (el) => (el as HTMLElement).dataset.seat ?? '',
  );
}

function winnerSeat(app: RenderResult): string | undefined {
  const won = app.getByTestId('trick-area').querySelector('.trick-card[data-winner]');
  return won === null ? undefined : ((won as HTMLElement).dataset.seat ?? '');
}

describe('linger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the resolved trick with its winner ~1.5s before the display releases', () => {
    const client = makeClient();
    const app = startLinger(client);
    // The bot wins and leads the next trick well inside the window.
    applyEvent(
      client,
      env(5, {
        t: 'gameView',
        view: {
          view: playView({
            toAct: 2,
            hand: [makeCard(2, 9)],
            handCounts: [1, 0, 1, 1],
            trick: { leader: 1, ledSuit: 3, plays: [{ seat: 1, card: makeCard(3, 10) }] },
            lastTrick: T1,
            tricksPlayed: 1,
            sideTricks: [0, 1],
          }),
        },
      }),
    );

    // Frozen: all four T1 cards up, winner ringed, next lead invisible.
    expect(app.getByTestId('trick-area').dataset.lingering).toBe('true');
    expect(shownSeats(app)).toEqual(['1', '2', '3', '0']);
    expect(winnerSeat(app)).toBe('1');

    act(() => {
      vi.advanceTimersByTime(TRICK_LINGER_MS - 1);
    });
    expect(shownSeats(app)).toEqual(['1', '2', '3', '0']);

    // The window closes: the live view (bot's lead) takes the table.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(app.getByTestId('trick-area').dataset.lingering).toBeUndefined();
    expect(shownSeats(app)).toEqual(['1']);
    expect(winnerSeat(app)).toBeUndefined();
  });

  it('chains tricks resolved inside the window without dropping any', () => {
    const client = makeClient();
    const app = startLinger(client);
    // Test-mode bots race through the whole next trick inside T1's linger.
    applyEvent(client, env(5, { t: 'trickResolved', trick: T2 }));
    applyEvent(
      client,
      env(6, {
        t: 'gameView',
        view: {
          view: playView({
            toAct: 3,
            hand: [],
            handCounts: [0, 0, 0, 0],
            trick: { leader: 3, ledSuit: null, plays: [] },
            lastTrick: T2,
            tricksPlayed: 2,
            sideTricks: [0, 2],
          }),
        },
      }),
    );

    // T1 finishes its full window first…
    expect(winnerSeat(app)).toBe('1');
    act(() => {
      vi.advanceTimersByTime(TRICK_LINGER_MS);
    });
    // …then T2 gets a full window of its own…
    expect(app.getByTestId('trick-area').dataset.lingering).toBe('true');
    expect(winnerSeat(app)).toBe('3');
    act(() => {
      vi.advanceTimersByTime(TRICK_LINGER_MS);
    });
    // …and the freeze releases (T2 stays up as the resolved-trick fallback).
    expect(app.getByTestId('trick-area').dataset.lingering).toBeUndefined();
    expect(winnerSeat(app)).toBe('3');
  });

  it('keeps the viewer\'s own next play live under the linger', () => {
    const client = makeClient();
    const app = startLinger(client, 0); // the viewer wins T1 and leads next
    applyEvent(
      client,
      env(5, {
        t: 'actionRequest',
        seat: 0,
        actions: [{ type: 'playCard', seat: 0, card: makeCard(2, 9) }],
      }),
    );

    // Display still frozen on T1, but the hand is already playable.
    expect(app.getByTestId('trick-area').dataset.lingering).toBe('true');
    expect(app.container.querySelector('.hand-card-playable')).not.toBeNull();
  });

  it('lets a gap-recovery full view win immediately', () => {
    const client = makeClient();
    const app = startLinger(client);
    expect(app.getByTestId('trick-area').dataset.lingering).toBe('true');

    // A dropped envelope: the next event skips seq 5, so the store asks for
    // a full view; when it lands the linger is abandoned on the spot.
    applyEvent(client, env(7, { t: 'handReady', ready: [1, 2, 3] }));
    expect(client.sent).toContainEqual({ t: 'requestState' });
    applyEvent(
      client,
      env(7, {
        t: 'gameView',
        view: {
          view: playView({
            toAct: 2,
            hand: [makeCard(2, 9)],
            trick: { leader: 1, ledSuit: 3, plays: [{ seat: 1, card: makeCard(3, 10) }] },
            lastTrick: T1,
            tricksPlayed: 1,
            sideTricks: [0, 1],
          }),
        },
      }),
    );
    expect(app.getByTestId('trick-area').dataset.lingering).toBeUndefined();
    expect(shownSeats(app)).toEqual(['1']);
  });

  it('makes the hand-end overlay wait out a hand-ending linger', () => {
    const client = makeClient();
    const app = startLinger(client);
    applyEvent(
      client,
      env(5, {
        t: 'gameView',
        view: {
          view: playView({
            phase: 'handScored',
            toAct: null,
            hand: [],
            handCounts: [0, 0, 0, 0],
            trick: null,
            lastTrick: T1,
            tricksPlayed: 10,
            sideTricks: [4, 6],
            scores: [-40, 300],
            handResult: {
              contract: bid(NUM, 8, 3),
              declarer: 1,
              slam: false,
              made: true,
              declarerDelta: 300,
              defenderDelta: 40,
              declarerSideTricks: 8,
              defenderSideTricks: 2,
            },
          }),
        },
      }),
    );

    // The final trick keeps its beat; the overlay only mounts afterwards.
    expect(app.queryByTestId('hand-end-overlay')).toBeNull();
    expect(app.getByTestId('trick-area').dataset.lingering).toBe('true');
    act(() => {
      vi.advanceTimersByTime(TRICK_LINGER_MS);
    });
    expect(app.queryByTestId('hand-end-overlay')).not.toBeNull();
  });
});

describe('trick collection sweep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sweeps the lingered trick toward the winning seat, then holds the cleared state', () => {
    const client = makeClient();
    const app = startLinger(client); // the seat-1 bot wins; viewer at 0 → left
    expect(app.getByTestId('trick-area').dataset.sweeping).toBeUndefined();

    // The sweep occupies the linger window's final beat.
    act(() => {
      vi.advanceTimersByTime(TRICK_LINGER_MS - TRICK_SWEEP_MS);
    });
    let area = app.getByTestId('trick-area');
    expect(area.dataset.lingering).toBe('true');
    expect(area.dataset.sweeping).toBe('true');
    expect(area.dataset.sweepTarget).toBe('left');
    expect(area.classList.contains('trick-sweeping')).toBe(true);
    expect(area.classList.contains('sweep-to-left')).toBe(true);
    // All four cards stay mounted while they travel.
    expect(shownSeats(app)).toEqual(['1', '2', '3', '0']);

    // Release: the fallback keeps the swept trick at its cleared end state
    // (still in the DOM for the record) instead of popping the cards back.
    act(() => {
      vi.advanceTimersByTime(TRICK_SWEEP_MS);
    });
    area = app.getByTestId('trick-area');
    expect(area.dataset.lingering).toBeUndefined();
    expect(area.dataset.sweeping).toBeUndefined();
    expect(area.classList.contains('trick-sweeping')).toBe(false);
    expect(area.classList.contains('trick-swept')).toBe(true);
    expect(area.classList.contains('sweep-to-left')).toBe(true);
    expect(shownSeats(app)).toEqual(['1', '2', '3', '0']);
  });

  it('aims the sweep at whichever seat won', () => {
    const client = makeClient();
    const app = startLinger(client, 2); // partner seat wins; viewer at 0 → top
    act(() => {
      vi.advanceTimersByTime(TRICK_LINGER_MS - TRICK_SWEEP_MS);
    });
    const area = app.getByTestId('trick-area');
    expect(area.dataset.sweepTarget).toBe('top');
    expect(area.classList.contains('sweep-to-top')).toBe(true);
  });

  it('skips the sweep under prefers-reduced-motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
    }));
    const client = makeClient();
    const app = startLinger(client);
    act(() => {
      vi.advanceTimersByTime(TRICK_LINGER_MS - TRICK_SWEEP_MS);
    });
    expect(app.getByTestId('trick-area').dataset.sweeping).toBeUndefined();
    expect(app.getByTestId('trick-area').className).toBe('trick-area');

    // Current behavior end to end: the release leaves the resolved fallback
    // fully visible (no sweep classes) until the next lead replaces it.
    act(() => {
      vi.advanceTimersByTime(TRICK_SWEEP_MS);
    });
    expect(app.getByTestId('trick-area').className).toBe('trick-area');
    expect(shownSeats(app)).toEqual(['1', '2', '3', '0']);
    expect(winnerSeat(app)).toBe('1');
  });
});

describe('last-trick peek', () => {
  function renderMidTrick(lastTrick: Trick | null): { app: RenderResult; client: TestClient } {
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
            lastTrick,
            tricksPlayed: lastTrick === null ? 0 : 1,
          }),
        },
      }),
    );
    return { app, client };
  }

  it('offers no peek before the first trick completes', () => {
    const { app } = renderMidTrick(null);
    expect(app.queryByTestId('last-trick-toggle')).toBeNull();
  });

  it('pops the previous trick with seat labels and the winner ringed', () => {
    const { app } = renderMidTrick(T1);
    expect(app.queryByTestId('last-trick-popover')).toBeNull();

    fireEvent.click(app.getByTestId('last-trick-toggle'));
    const popover = app.getByTestId('last-trick-popover');
    const entries = [...popover.querySelectorAll('li')];
    expect(entries.map((li) => li.dataset.seat)).toEqual(['1', '2', '3', '0']);
    expect(entries.map((li) => li.textContent)).toEqual([
      expect.stringContaining('Bot 2'),
      expect.stringContaining('Bot 3'),
      expect.stringContaining('Bot 4'),
      expect.stringContaining('Ana'),
    ]);
    const winner = popover.querySelector('li[data-winner]');
    expect((winner as HTMLElement).dataset.seat).toBe('1');
    expect(app.getByTestId('last-trick-winner').textContent).toBe('Won by Bot 2');

    fireEvent.click(app.getByTestId('last-trick-toggle'));
    expect(app.queryByTestId('last-trick-popover')).toBeNull();
  });
});
