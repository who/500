// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { NAME_STORAGE_KEY } from './Home.tsx';
import {
  applyEvent,
  env,
  gameViewFixture,
  installFakeLocalStorage,
  makeClient,
  renderApp,
  roomViewFixture,
} from './test-helpers.tsx';

let stored: Map<string, string>;

beforeEach(() => {
  stored = installFakeLocalStorage();
  history.replaceState(null, '', '/');
});

describe('Home', () => {
  it('prefills the join code from a shared #/room link', () => {
    location.hash = '#/room/abcde';
    const view = renderApp(makeClient());
    const input = view.getByLabelText('Room code');
    expect((input as HTMLInputElement).value).toBe('ABCDE');
  });

  it('normalizes pasted codes and sends joinRoom with the trimmed name', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    const view = renderApp(client);

    await user.click(view.getByRole('button', { name: 'Multiplayer' }));
    await user.type(view.getByLabelText('Your name'), '  Ana  ');
    const code = view.getByLabelText('Room code');
    await user.type(code, ' ab cde ');
    expect((code as HTMLInputElement).value).toBe('ABCDE');

    await user.click(view.getByRole('button', { name: 'Join room' }));
    expect(client.sent).toEqual([{ t: 'joinRoom', roomCode: 'ABCDE', name: 'Ana' }]);
    expect(stored.get(NAME_STORAGE_KEY)).toBe('Ana');
  });

  it('renders a server join error inline and clears it on the next attempt', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    const view = renderApp(client);

    await user.click(view.getByRole('button', { name: 'Multiplayer' }));
    await user.type(view.getByLabelText('Room code'), 'ABCDE');
    await user.click(view.getByRole('button', { name: 'Join room' }));
    applyEvent(client, { event: { t: 'error', code: 'badCommand', message: 'Room is full.' } });
    expect(view.getByRole('alert').textContent).toBe('Room is full.');

    await user.click(view.getByRole('button', { name: 'Join room' }));
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('creates a room and claims seat 0 from Multiplayer, defaulting an empty name to Player', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    const view = renderApp(client);

    await user.click(view.getByRole('button', { name: 'Multiplayer' }));
    await user.click(view.getByRole('button', { name: 'Create room' }));
    expect(client.sent).toEqual([
      { t: 'createRoom', name: 'Player' },
      { t: 'sit', seat: 0 },
    ]);
  });

  it('Single player sends create, sit, and startGame and stays on Home until the table', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    const view = renderApp(client);

    await user.click(view.getByRole('button', { name: 'Single player' }));
    expect(client.sent).toEqual([
      { t: 'createRoom', name: 'Player' },
      { t: 'sit', seat: 0 },
      { t: 'startGame' },
    ]);
    expect(client.store.getState().soloStarting).toBe(true);

    applyEvent(
      client,
      env(0, { t: 'roomState', room: roomViewFixture({ roomCode: 'SOLO1', hostSeat: 0 }) }),
    );
    expect(view.container.querySelector('[data-screen="home"]')).not.toBeNull();
    expect(view.container.querySelector('[data-screen="lobby"]')).toBeNull();
    expect(location.hash).not.toContain('SOLO1');
    expect(view.getByText('Starting…')).toBeTruthy();

    applyEvent(client, { event: { t: 'seatGranted', seat: 0, token: 'tok-solo' } });
    applyEvent(client, env(1, { t: 'gameView', view: gameViewFixture(0) }));
    expect(client.store.getState().soloStarting).toBe(false);
    expect(view.container.querySelector('[data-screen="table"]')).not.toBeNull();
  });

  it('solo error stays on Home and shows the inline error', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    const view = renderApp(client);

    await user.click(view.getByRole('button', { name: 'Single player' }));
    applyEvent(
      client,
      env(0, { t: 'roomState', room: roomViewFixture({ roomCode: 'SOLO1', hostSeat: 0 }) }),
    );
    applyEvent(client, { event: { t: 'error', code: 'badCommand', message: 'Already in a room.' } });
    expect(view.container.querySelector('[data-screen="home"]')).not.toBeNull();
    expect(view.container.querySelector('[data-screen="lobby"]')).toBeNull();
    expect(view.getByRole('alert').textContent).toBe('Already in a room.');
    expect(client.store.getState().soloStarting).toBe(false);
    expect(client.store.getState().roomView).toBeNull();
    expect(client.sent).toContainEqual({ t: 'leaveRoom' });
  });

  it('restores a previously used name from localStorage', () => {
    stored.set(NAME_STORAGE_KEY, 'Maia');
    const view = renderApp(makeClient());
    expect((view.getByLabelText('Your name') as HTMLInputElement).value).toBe('Maia');
  });

  it('disables Single player and Multiplayer until the socket is open', () => {
    const client = makeClient();
    client.store.getState().setConnection('connecting');
    const view = renderApp(client);
    expect((view.getByRole('button', { name: 'Single player' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((view.getByRole('button', { name: 'Multiplayer' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
