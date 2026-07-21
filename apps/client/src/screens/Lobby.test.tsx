// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RoomView } from '@five-hundred/protocol';
import { derivePhase } from './router.tsx';
import {
  applyEvent,
  botSeatView,
  emptySeatView,
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

/** Room with Ana hosting from seat 0; remaining seats empty. */
function anaRoom(overrides: Partial<RoomView> = {}): RoomView {
  return roomViewFixture({
    hostSeat: 0,
    seats: [humanSeatView(0, 'Ana'), emptySeatView(1), emptySeatView(2), emptySeatView(3)],
    ...overrides,
  });
}

function seatHost(client: TestClient, room: RoomView = anaRoom()): void {
  applyEvent(client, env(0, { t: 'roomState', room }));
  applyEvent(client, { event: { t: 'seatGranted', seat: 0, token: 'tok-host' } });
}

function seatElement(view: ReturnType<typeof renderApp>, seat: number): HTMLElement {
  const el = view.container.querySelector(`[data-seat="${seat}"]`);
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

describe('Lobby', () => {
  it('reaches the lobby after create, and a second client joining by code sees the same room (AC-1)', async () => {
    const user = userEvent.setup();

    // Host: create flow from Home.
    const host = makeClient();
    const hostView = renderApp(host);
    await user.type(within(hostView.container).getByLabelText('Your name'), 'Ana');
    await user.click(within(hostView.container).getByRole('button', { name: 'Create room' }));
    expect(host.sent).toEqual([
      { t: 'createRoom', name: 'Ana' },
      { t: 'sit', seat: 0 },
    ]);
    seatHost(host);
    expect(within(hostView.container).getByTestId('room-code').textContent).toBe('ABCDE');

    // Joiner: enters the code (prefilled by the shared link hash set above).
    const joiner = makeClient();
    const joinerView = renderApp(joiner);
    const codeInput = within(joinerView.container).getByLabelText('Room code');
    expect((codeInput as HTMLInputElement).value).toBe('ABCDE');
    // The name input prefills "Ana" from the (shared jsdom) localStorage.
    const joinerName = within(joinerView.container).getByLabelText('Your name');
    await user.clear(joinerName);
    await user.type(joinerName, 'Ben');
    await user.click(within(joinerView.container).getByRole('button', { name: 'Join room' }));
    expect(joiner.sent).toEqual([{ t: 'joinRoom', roomCode: 'ABCDE', name: 'Ben' }]);

    // Server broadcast after Ben sits: both clients render the same lobby.
    const both = anaRoom({
      seats: [humanSeatView(0, 'Ana'), humanSeatView(1, 'Ben'), emptySeatView(2), emptySeatView(3)],
    });
    applyEvent(host, env(1, { t: 'roomState', room: both }));
    applyEvent(joiner, env(1, { t: 'roomState', room: both }));
    for (const view of [hostView, joinerView]) {
      const scoped = within(view.container);
      expect(scoped.getByTestId('room-code').textContent).toBe('ABCDE');
      expect(scoped.getByText('Ana')).toBeTruthy();
      expect(scoped.getByText('Ben')).toBeTruthy();
    }
  });

  it('claims a seat by clicking an open seat', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    const view = renderApp(client);
    applyEvent(client, env(0, { t: 'roomState', room: anaRoom() }));

    await user.click(within(seatElement(view, 2)).getByRole('button', { name: 'Sit here' }));
    expect(client.sent).toEqual([{ t: 'sit', seat: 2 }]);
  });

  it('shows enabled host controls to the host only (AC-2)', () => {
    const host = makeClient();
    const hostView = renderApp(host);
    seatHost(host);
    const hostScoped = within(hostView.container);
    for (const seat of [1, 2, 3]) {
      const select = hostScoped.getByLabelText(`Seat ${seat + 1} bot difficulty`);
      expect((select as HTMLSelectElement).disabled).toBe(false);
    }
    expect(
      (hostScoped.getByRole('button', { name: 'Start game' }) as HTMLButtonElement).disabled,
    ).toBe(false);

    const guest = makeClient();
    const guestView = renderApp(guest);
    const room = anaRoom({
      seats: [humanSeatView(0, 'Ana'), humanSeatView(1, 'Ben'), emptySeatView(2), emptySeatView(3)],
    });
    applyEvent(guest, env(0, { t: 'roomState', room }));
    applyEvent(guest, { event: { t: 'seatGranted', seat: 1, token: 'tok-guest' } });
    const guestScoped = within(guestView.container);
    for (const seat of [2, 3]) {
      const select = guestScoped.getByLabelText(`Seat ${seat + 1} bot difficulty`);
      expect((select as HTMLSelectElement).disabled).toBe(true);
    }
    expect(guestScoped.queryByRole('button', { name: 'Start game' })).toBeNull();
    expect(guestScoped.getByText(/Waiting for the host/)).toBeTruthy();
  });

  it('sends configureBots on a difficulty change and everyone sees the broadcast (AC-2)', async () => {
    const user = userEvent.setup();
    const host = makeClient();
    const hostView = renderApp(host);
    seatHost(host);
    const hostSelect = within(seatElement(hostView, 2)).getByRole('combobox');
    await user.selectOptions(hostSelect, 'hard');
    expect(host.sent).toContainEqual({
      t: 'configureBots',
      bots: [{ seat: 2, difficulty: 'hard' }],
    });

    // The resulting broadcast updates a non-host client's selector too.
    const guest = makeClient();
    const guestView = renderApp(guest);
    const updated = anaRoom({
      seats: [
        humanSeatView(0, 'Ana'),
        emptySeatView(1),
        { ...emptySeatView(2), difficulty: 'hard' },
        emptySeatView(3),
      ],
    });
    applyEvent(guest, env(0, { t: 'roomState', room: updated }));
    const guestSelect = within(seatElement(guestView, 2)).getByRole('combobox');
    expect((guestSelect as HTMLSelectElement).value).toBe('hard');
  });

  it('renders your seat at the bottom with your partner across', () => {
    const client = makeClient();
    const view = renderApp(client);
    const room = anaRoom({
      hostSeat: 2,
      seats: [emptySeatView(0), emptySeatView(1), humanSeatView(2, 'Cal'), emptySeatView(3)],
    });
    applyEvent(client, env(0, { t: 'roomState', room }));
    applyEvent(client, { event: { t: 'seatGranted', seat: 2, token: 'tok-cal' } });

    expect(seatElement(view, 2).dataset.position).toBe('bottom');
    expect(seatElement(view, 0).dataset.position).toBe('top');
    expect(seatElement(view, 3).dataset.position).toBe('left');
    expect(seatElement(view, 1).dataset.position).toBe('right');
  });

  it('start fills empty seats with bots and moves every client to the table (AC-3)', async () => {
    const user = userEvent.setup();
    const host = makeClient();
    const hostView = renderApp(host);
    seatHost(host);
    const guest = makeClient();
    const guestView = renderApp(guest);
    const preStart = anaRoom({
      seats: [humanSeatView(0, 'Ana'), humanSeatView(1, 'Ben'), emptySeatView(2), emptySeatView(3)],
    });
    applyEvent(guest, env(0, { t: 'roomState', room: preStart }));
    applyEvent(guest, { event: { t: 'seatGranted', seat: 1, token: 'tok-guest' } });

    await user.click(within(hostView.container).getByRole('button', { name: 'Start game' }));
    expect(host.sent).toContainEqual({ t: 'startGame' });

    // Server: roomState with bots in the empty seats, then a per-seat gameView.
    const started = anaRoom({
      started: true,
      seats: [
        humanSeatView(0, 'Ana'),
        humanSeatView(1, 'Ben'),
        botSeatView(2, 'medium'),
        botSeatView(3, 'hard'),
      ],
    });
    applyEvent(host, env(1, { t: 'roomState', room: started }));
    applyEvent(host, env(2, { t: 'gameView', view: gameViewFixture(0) }));
    applyEvent(guest, env(1, { t: 'roomState', room: started }));
    applyEvent(guest, env(2, { t: 'gameView', view: gameViewFixture(1) }));

    for (const client of [host, guest]) {
      expect(derivePhase(client.store.getState())).toBe('table');
      const seats = client.store.getState().roomView?.seats ?? [];
      expect(seats[2]?.occupant).toBe('bot');
      expect(seats[3]?.occupant).toBe('bot');
    }
    expect(hostView.container.querySelector('[data-screen="table"]')).not.toBeNull();
    expect(guestView.container.querySelector('[data-screen="table"]')).not.toBeNull();
  });
});
