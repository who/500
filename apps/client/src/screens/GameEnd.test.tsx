// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
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
});
