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
    expect(guestScoped.queryByRole('button', { name: 'Start game' })).toBeNull();
    expect(guestScoped.getByText(/Waiting for the host/)).toBeTruthy();
  });

  it('has no difficulty control and no tier label on non-human seats (fh-gpk AC-1, fh-ehj AC-1)', () => {
    const host = makeClient();
    const hostView = renderApp(host);
    seatHost(
      host,
      anaRoom({
        seats: [humanSeatView(0, 'Ana'), emptySeatView(1), emptySeatView(2), botSeatView(3)],
      }),
    );
    const scoped = within(hostView.container);
    // The selector is gone for everyone, host included...
    expect(scoped.queryAllByRole('combobox')).toEqual([]);
    expect(hostView.container.querySelector('[data-testid="difficulty-1"]')).toBeNull();
    // ...and so is the tier label: bots read as "AI <name>", open seats as "Open seat".
    for (const seat of [1, 2, 3]) {
      const scopedSeat = within(seatElement(hostView, seat));
      expect(scopedSeat.queryByTestId(`bot-tier-${seat}`)).toBeNull();
      expect(scopedSeat.queryByText(/Hard bot/)).toBeNull();
    }
    expect(within(seatElement(hostView, 3)).getByText('AI Noah')).toBeTruthy();
    for (const seat of [1, 2]) {
      expect(within(seatElement(hostView, seat)).getByText('Open seat')).toBeTruthy();
    }
    // Rendering the lobby never sends a bot-configuration command.
    expect(host.sent.filter((c) => c.t === 'configureBots')).toEqual([]);
  });

  it('guides an unseated arrival, a seated guest and the host differently (fh-0nj AC-1/AC-2/AC-3)', () => {
    const guidance = (view: ReturnType<typeof renderApp>): string =>
      within(view.container).getByTestId('lobby-guidance').textContent ?? '';

    // Just arrived, no seat yet: told to sit, and what open seats become.
    const visitor = makeClient();
    const visitorView = renderApp(visitor);
    applyEvent(visitor, env(0, { t: 'roomState', room: anaRoom() }));
    expect(guidance(visitorView)).toBe(
      'Pick a seat to join — tap Sit here on any open seat. Empty seats are filled with AI players when the game starts.',
    );

    // Seated guest: own seat (1-based), who starts, the code to share.
    const guest = makeClient();
    const guestView = renderApp(guest);
    applyEvent(
      guest,
      env(0, {
        t: 'roomState',
        room: anaRoom({
          seats: [humanSeatView(0, 'Ana'), humanSeatView(1, 'Ben'), emptySeatView(2), emptySeatView(3)],
        }),
      }),
    );
    applyEvent(guest, { event: { t: 'seatGranted', seat: 1, token: 'tok-guest' } });
    expect(guidance(guestView)).toBe(
      "You're in seat 2. The host starts the game when everyone is ready — others can join with room code ABCDE, and empty seats become AI players.",
    );

    // Host: how to invite, and how to start.
    const host = makeClient();
    const hostView = renderApp(host);
    seatHost(host);
    expect(guidance(hostView)).toBe(
      "You're the host. Share code ABCDE for others to join, then press Start game when ready — any empty seats fill with AI players.",
    );

    // AC-2: no copy anywhere in the lobby mentions choosing a difficulty.
    for (const view of [visitorView, guestView, hostView]) {
      expect(view.container.textContent).not.toMatch(/difficult/i);
    }
  });

  it('offers a how-to-play summary for a total newcomer (fh-0nj)', () => {
    const client = makeClient();
    const view = renderApp(client);
    applyEvent(client, env(0, { t: 'roomState', room: anaRoom() }));
    const scoped = within(view.container);
    expect(scoped.getByText('How to play 500')).toBeTruthy();
    const link = scoped.getByRole('link', { name: 'Read our house rules' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toContain('500-house-rules.md');
  });

  it('shows the learned tag and lets the host toggle adaptive bots (fh-sja.6)', async () => {
    const user = userEvent.setup();
    const host = makeClient();
    const hostView = renderApp(host);
    seatHost(host, anaRoom({ learnedVersion: '1.abcd1234', adaptiveBots: true }));

    // The lobby surfaces the loaded overlay version.
    const tag = within(hostView.container).getByTestId('learned-tag');
    expect(tag.textContent).toContain('learned v1.abcd1234');

    // Host toggles the opt-in off -> setAdaptiveBots command.
    const toggle = within(hostView.container).getByTestId('adaptive-bots') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
    await user.click(toggle);
    expect(host.sent).toContainEqual({ t: 'setAdaptiveBots', on: false });
  });

  it('hides the learned tag and toggle when the server ships no overlay (fh-sja.6)', () => {
    const client = makeClient();
    const view = renderApp(client);
    seatHost(client, anaRoom({ learnedVersion: null }));
    expect(view.container.querySelector('[data-testid="learned-tag"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="adaptive-bots"]')).toBeNull();
  });

  it('disables the adaptive toggle for a non-host (fh-sja.6)', () => {
    const guest = makeClient();
    const guestView = renderApp(guest);
    // Guest sees the room but does not hold the host seat.
    applyEvent(
      guest,
      env(0, { t: 'roomState', room: anaRoom({ learnedVersion: '1.abcd1234', adaptiveBots: true }) }),
    );
    applyEvent(guest, { event: { t: 'seatGranted', seat: 1, token: 'tok-guest' } });
    const toggle = guestView.container.querySelector('[data-testid="adaptive-bots"]') as HTMLInputElement;
    expect(toggle).not.toBeNull();
    expect(toggle.disabled).toBe(true);
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
        botSeatView(2),
        botSeatView(3),
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
