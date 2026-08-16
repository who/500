// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { GameLogHand } from '@five-hundred/protocol';
import { derivePhase } from './router.tsx';
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
} from './test-helpers.tsx';

beforeEach(() => {
  installFakeLocalStorage();
  history.replaceState(null, '', '/');
});

function gameEndRoom(hostSeat: number) {
  return roomViewFixture({
    started: true,
    hostSeat,
    seats: [
      humanSeatView(0, 'Ana'),
      botSeatView(1),
      humanSeatView(2, 'Cleo'),
      botSeatView(3),
    ],
  });
}

/** Render the router with a gameOver view for `seat`; host holds `hostSeat`. */
function renderGameEnd(
  seat: number,
  hostSeat: number,
  winner: number,
  scores: readonly [number, number],
): { client: TestClient; app: ReturnType<typeof renderApp> } {
  const client = makeClient();
  const app = renderApp(client);
  applyEvent(client, env(0, { t: 'roomState', room: gameEndRoom(hostSeat) }));
  applyEvent(client, env(1, { t: 'gameOver', winner, scores: [...scores] as [number, number] }));
  applyEvent(
    client,
    env(2, {
      t: 'gameView',
      view: gameViewFixture(seat, {
        phase: 'gameOver',
        winner,
        scores: [...scores] as [number, number],
        toAct: null,
        hand: [],
      }),
    }),
  );
  return { client, app };
}

describe('GameEnd', () => {
  it('routes a gameOver view to the game-end screen with winner and final score', () => {
    const { app } = renderGameEnd(0, 0, 0, [520, 180]);
    expect(app.container.querySelector('[data-screen="game-end"]')).not.toBeNull();
    expect(app.getByTestId('game-end-headline').textContent).toBe('You win!');
    expect(app.getByTestId('game-end-winners').textContent).toBe('Ana & Cleo take the game.');
    expect(app.getByTestId('game-end-scores').textContent).toBe('Final score: Us 520 – Them 180');
    expect(app.queryByTestId('game-end-otb')).toBeNull();
  });

  it('orients the result to a losing viewer', () => {
    // Same game seen from seat 1 (a bot seat in the room, but the view rules).
    const { app } = renderGameEnd(1, 0, 0, [520, 180]);
    expect(app.getByTestId('game-end-headline').textContent).toBe('You lose');
    expect(app.getByTestId('game-end-scores').textContent).toBe('Final score: Us 180 – Them 520');
  });

  it('calls out a loser who went out the back', () => {
    const { app } = renderGameEnd(0, 0, 0, [520, -510]);
    expect(app.getByTestId('game-end-otb').textContent).toContain('Out the back!');
    expect(app.getByTestId('game-end-otb').textContent).toContain('-510');
  });

  it('offers rematch to the host only, sending the rematch command (AC-3 gating)', () => {
    const host = renderGameEnd(0, 0, 1, [180, 520]);
    fireEvent.click(host.app.getByTestId('game-end-rematch'));
    expect(host.client.sent).toEqual([{ t: 'rematch' }]);
    host.app.unmount();

    const guest = renderGameEnd(0, 2, 1, [180, 520]);
    expect(guest.app.queryByTestId('game-end-rematch')).toBeNull();
    expect(guest.app.getByTestId('game-end-wait-host').textContent).toBe(
      'Waiting for Cleo to start a rematch.',
    );
    expect(guest.client.sent).toEqual([]);
  });

  it('returns to the table when a rematch delivers a fresh auction view', () => {
    const { client, app } = renderGameEnd(0, 0, 0, [520, 180]);
    applyEvent(client, env(3, { t: 'roomState', room: gameEndRoom(0) }));
    applyEvent(
      client,
      env(4, { t: 'gameView', view: gameViewFixture(0, { phase: 'auction', scores: [0, 0] }) }),
    );
    expect(app.container.querySelector('[data-screen="game-end"]')).toBeNull();
    expect(app.container.querySelector('[data-screen="table"]')).not.toBeNull();
    expect(app.getByTestId('hud-scores').textContent).toBe('Score 0 / 0');
  });

  // AC-2: the reveal fade rides a class on the root; reduced motion skips it.
  it('carries the fade-in class, withheld under prefers-reduced-motion', () => {
    const { app } = renderGameEnd(0, 0, 0, [520, 180]);
    const root = app.container.querySelector('[data-screen="game-end"]');
    expect(root?.classList.contains('game-end-fade')).toBe(true);
    app.unmount();

    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
    }));
    try {
      const reduced = renderGameEnd(0, 0, 0, [520, 180]);
      const reducedRoot = reduced.app.container.querySelector('[data-screen="game-end"]');
      expect(reducedRoot?.classList.contains('game-end-fade')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // AC-3: Review the table -> read-only table -> Back to results.
  it('reviews the finished table and returns to the results', () => {
    const { app } = renderGameEnd(0, 0, 0, [520, 180]);
    fireEvent.click(app.getByTestId('game-end-review'));
    expect(app.container.querySelector('[data-screen="game-end"]')).toBeNull();
    expect(app.container.querySelector('[data-screen="table"]')).not.toBeNull();
    // Read-only: no pending actions in gameOver, so no action panels mount.
    expect(app.container.querySelector('.bid-panel')).toBeNull();
    fireEvent.click(app.getByTestId('review-return'));
    expect(app.container.querySelector('[data-screen="table"]')).toBeNull();
    expect(app.container.querySelector('[data-screen="game-end"]')).not.toBeNull();
  });

  // fh-y2a.2 AC-3: the Game log toggle renders the stored summary — dealer
  // names, the bid/pass sequence, trick leader/winner rows, running totals.
  it('shows the game log behind its toggle from a stored summary', () => {
    const hands: GameLogHand[] = [
      {
        handNumber: 0,
        dealer: 3,
        redeals: 0,
        auction: [
          { seat: 0, bid: { kind: 'NUM', level: 7, strain: 0 } },
          { seat: 1, bid: { kind: 'PASS', level: 0, strain: -1 } },
          { seat: 2, bid: { kind: 'PASS', level: 0, strain: -1 } },
          { seat: 3, bid: { kind: 'PASS', level: 0, strain: -1 } },
        ],
        tricks: [
          { leader: 0, winner: 0 },
          { leader: 0, winner: 2 },
        ],
        scores: [140, 20],
      },
      {
        handNumber: 1,
        dealer: 0,
        redeals: 1,
        auction: [{ seat: 1, bid: { kind: 'NULLA', level: 0, strain: -1 } }],
        tricks: [{ leader: 1, winner: 3 }],
        scores: [140, 270],
      },
    ];
    const { client, app } = renderGameEnd(0, 0, 0, [520, 180]);
    expect(app.queryByTestId('game-end-log')).toBeNull(); // no summary yet
    applyEvent(client, env(3, { t: 'gameLog', hands }));

    fireEvent.click(app.getByTestId('game-end-log'));
    expect(app.getAllByTestId('game-log-dealer').map((el) => el.textContent)).toEqual([
      'Hand 1 — dealt by AI Noah',
      'Hand 2 — dealt by Ana',
    ]);
    expect(app.getAllByTestId('game-log-auction').map((el) => el.textContent)).toEqual([
      'Ana: 7S, AI Liam: Pass, Cleo: Pass, AI Noah: Pass',
      'AI Liam: Nulla',
    ]);
    expect(app.getAllByTestId('game-log-trick').map((el) => el.textContent)).toEqual([
      'Trick 1: Ana led, Ana won',
      'Trick 2: Ana led, Cleo won',
      'Trick 1: AI Liam led, AI Noah won',
    ]);
    expect(app.getAllByTestId('game-log-scores').map((el) => el.textContent)).toEqual([
      'After: Us 140 – Them 20',
      'After: Us 140 – Them 270',
    ]);
    // Only the redealt hand mentions its thrown-in auction.
    expect(app.getAllByTestId('game-log-redeals').map((el) => el.textContent)).toEqual([
      'Thrown in once before this deal — every seat passed.',
    ]);

    fireEvent.click(app.getByTestId('game-end-log')); // toggle back off
    expect(app.queryByTestId('game-log')).toBeNull();
  });

  it('Leave sits beside Rematch, sends leaveRoom, and returns Home', () => {
    const { client, app } = renderGameEnd(0, 0, 0, [520, 180]);
    expect(app.getByTestId('game-end-rematch')).not.toBeNull();
    fireEvent.click(app.getByRole('button', { name: 'Leave' }));
    expect(client.sent).toEqual([{ t: 'leaveRoom' }]);
    expect(client.store.getState().roomView).toBeNull();
    expect(app.container.querySelector('[data-screen="home"]')).not.toBeNull();
  });
});

// AC-1: the router holds the table while the reveal delay runs or a review
// is open, and shows the game-end screen once revealed.
describe('derivePhase end-game gating', () => {
  const over = gameViewFixture(0, {
    phase: 'gameOver',
    winner: 0,
    scores: [520, 180],
    toAct: null,
    hand: [],
  });

  it('maps gameOver through gameEndRevealed and reviewingTable', () => {
    expect(derivePhase({ seatView: over, roomView: null, gameEndRevealed: false })).toBe('table');
    expect(derivePhase({ seatView: over, roomView: null, gameEndRevealed: true })).toBe('gameEnd');
    expect(
      derivePhase({ seatView: over, roomView: null, gameEndRevealed: true, reviewingTable: true }),
    ).toBe('table');
    // Callers without the new flags keep the old direct mapping.
    expect(derivePhase({ seatView: over, roomView: null })).toBe('gameEnd');
  });
});
