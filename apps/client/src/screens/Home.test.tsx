// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { NAME_STORAGE_KEY } from './Home.tsx';
import { applyEvent, installFakeLocalStorage, makeClient, renderApp } from './test-helpers.tsx';

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

    await user.type(view.getByLabelText('Room code'), 'ABCDE');
    await user.click(view.getByRole('button', { name: 'Join room' }));
    applyEvent(client, { event: { t: 'error', code: 'badCommand', message: 'Room is full.' } });
    expect(view.getByRole('alert').textContent).toBe('Room is full.');

    await user.click(view.getByRole('button', { name: 'Join room' }));
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('creates a room and claims seat 0, defaulting an empty name to Player', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    const view = renderApp(client);

    await user.click(view.getByRole('button', { name: 'Create room' }));
    expect(client.sent).toEqual([
      { t: 'createRoom', name: 'Player' },
      { t: 'sit', seat: 0 },
    ]);
  });

  it('restores a previously used name from localStorage', () => {
    stored.set(NAME_STORAGE_KEY, 'Maia');
    const view = renderApp(makeClient());
    expect((view.getByLabelText('Your name') as HTMLInputElement).value).toBe('Maia');
  });

  it('disables create and join until the socket is open', () => {
    const client = makeClient();
    client.store.getState().setConnection('connecting');
    const view = renderApp(client);
    expect((view.getByRole('button', { name: 'Create room' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((view.getByRole('button', { name: 'Join room' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
