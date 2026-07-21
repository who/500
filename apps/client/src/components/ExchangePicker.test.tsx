// @vitest-environment jsdom

import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type RedactedView, NUM, bid, makeCard } from '@five-hundred/engine';
import type { ClientCommand } from '@five-hundred/protocol';
import { ExchangePicker } from './ExchangePicker.tsx';
import {
  applyEvent,
  botSeatView,
  env,
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

const ROOM = roomViewFixture({
  started: true,
  hostSeat: 0,
  seats: [
    humanSeatView(0, 'Ana'),
    humanSeatView(1, 'Ben'),
    humanSeatView(2, 'Cleo'),
    botSeatView(3, 'hard'),
  ],
});

// Declarer's 15 after the pickup: every spade plus four low clubs, 8♥ by Ana.
const SPADES = Array.from({ length: 11 }, (_, i) => makeCard(0, 4 + i));
const CLUBS = [makeCard(1, 4), makeCard(1, 5), makeCard(1, 6), makeCard(1, 7)];
const HAND15 = [...SPADES, ...CLUBS];

function exchangeView(overrides: Partial<RedactedView> = {}): RedactedView {
  return {
    seat: 0,
    phase: 'middleExchange',
    handNumber: 1,
    dealer: 3,
    redeals: 0,
    toAct: 0,
    hand: HAND15,
    handCounts: [15, 10, 10, 10],
    middleCount: 0,
    discardCount: 0,
    contract: bid(NUM, 8, 3),
    declarer: 0,
    slam: false,
    activeSeats: [0, 1, 2, 3],
    auction: null,
    trick: null,
    lastTrick: null,
    sideTricks: [0, 0],
    tricksPlayed: 0,
    scores: [0, 0],
    winner: null,
    handResult: null,
    ...overrides,
  };
}

function renderExchange(view = exchangeView()) {
  const client = makeClient();
  const app = renderApp(client);
  applyEvent(client, env(0, { t: 'roomState', room: ROOM }));
  applyEvent(client, env(1, { t: 'gameView', view: { view } }));
  applyEvent(
    client,
    env(2, {
      t: 'actionRequest',
      seat: 0,
      actions: [{ type: 'discardKeeps', seat: 0, keeps: [] }],
    }),
  );
  return { client, app };
}

function pickerCard(app: ReturnType<typeof renderApp>, card: number): HTMLButtonElement {
  const buttons = [...app.getByTestId('exchange-picker').querySelectorAll('button.exchange-card')];
  const match = buttons.find(
    (b) => b.querySelector('[data-card]')?.getAttribute('data-card') === String(card),
  );
  expect(match).toBeDefined();
  return match as HTMLButtonElement;
}

function confirmButton(app: ReturnType<typeof renderApp>): HTMLButtonElement {
  return app.getByTestId('exchange-confirm') as HTMLButtonElement;
}

function sentDiscards(client: TestClient): ClientCommand[] {
  return client.sent.filter((c) => c.t === 'discardKeeps');
}

describe('ExchangePicker', () => {
  it('enables confirm at exactly 5 marked discards — not 4, not 6 (AC-1)', () => {
    const { app } = renderExchange();

    // Four marks: still short.
    for (const card of CLUBS) fireEvent.click(pickerCard(app, card));
    expect(app.getByTestId('exchange-count').textContent).toContain('4/5 selected');
    expect(confirmButton(app).disabled).toBe(true);

    // Exactly five: confirm opens.
    fireEvent.click(pickerCard(app, SPADES[0] as number));
    expect(app.getByTestId('exchange-count').textContent).toContain('5/5 selected');
    expect(confirmButton(app).disabled).toBe(false);

    // A sixth mark closes it again.
    fireEvent.click(pickerCard(app, SPADES[1] as number));
    expect(app.getByTestId('exchange-count').textContent).toContain('6/5 selected');
    expect(confirmButton(app).disabled).toBe(true);

    // Tapping a marked card unmarks it: back to five and open.
    fireEvent.click(pickerCard(app, SPADES[1] as number));
    expect(confirmButton(app).disabled).toBe(false);

    // Marked cards carry the visual discard mark; unmarked do not.
    expect(pickerCard(app, CLUBS[0] as number).dataset.discard).toBe('true');
    expect(pickerCard(app, SPADES[1] as number).dataset.discard).toBeUndefined();
  });

  it('submits keeps = the held 15 minus the 5 marked, then locks (AC-2)', () => {
    const { client, app } = renderExchange();
    const discards = [...CLUBS, SPADES[0] as number];
    for (const card of discards) fireEvent.click(pickerCard(app, card));
    fireEvent.click(confirmButton(app));

    const sent = sentDiscards(client);
    expect(sent).toHaveLength(1);
    const keeps = (sent[0] as { keeps: readonly number[] }).keeps;
    expect(keeps).toHaveLength(10);
    expect(new Set(keeps)).toEqual(new Set(SPADES.slice(1)));

    // Locked until the next view: no re-marking, no double submit.
    expect(app.getByTestId('exchange-picker').dataset.locked).toBe('true');
    fireEvent.click(pickerCard(app, SPADES[1] as number));
    expect(app.getByTestId('exchange-count').textContent).toContain('5/5 selected');
    fireEvent.click(confirmButton(app));
    expect(sentDiscards(client)).toHaveLength(1);

    // The post-exchange view unmounts the picker and restores the play hand.
    applyEvent(
      client,
      env(3, {
        t: 'gameView',
        view: {
          view: exchangeView({
            phase: 'play',
            hand: SPADES.slice(1),
            handCounts: [10, 10, 10, 10],
            discardCount: 5,
            trick: { leader: 0, ledSuit: null, plays: [] },
          }),
        },
      }),
    );
    expect(app.queryByTestId('exchange-picker')).toBeNull();
    expect(app.getByTestId('my-hand').querySelectorAll('[data-card]')).toHaveLength(10);
  });

  it('shows the other seats the abstract pickup status, never the cards (AC-3)', () => {
    // Cleo (seat 2) is exchanging; the viewer holds their ordinary 10.
    const client = makeClient();
    const app = renderApp(client);
    applyEvent(client, env(0, { t: 'roomState', room: ROOM }));
    applyEvent(
      client,
      env(1, {
        t: 'gameView',
        view: {
          view: exchangeView({
            toAct: 2,
            declarer: 2,
            hand: SPADES.slice(0, 10),
            handCounts: [10, 10, 15, 10],
          }),
        },
      }),
    );

    expect(app.queryByTestId('exchange-picker')).toBeNull();
    expect(app.getByTestId('exchange-status').textContent).toBe(
      'Cleo picked up the middle and is discarding 5…',
    );
    // The viewer's own inert hand still shows.
    expect(app.getByTestId('my-hand').querySelectorAll('[data-card]')).toHaveLength(10);
  });

  it('surfaces a server rejection verbatim and unlocks for a retry', () => {
    const { client, app } = renderExchange();
    for (const card of [...CLUBS, SPADES[0] as number]) fireEvent.click(pickerCard(app, card));
    fireEvent.click(confirmButton(app));
    expect(app.getByTestId('exchange-picker').dataset.locked).toBe('true');

    applyEvent(client, {
      event: { t: 'error', code: 'illegalAction', message: 'must keep exactly 10 distinct cards' },
    });
    expect(app.getByTestId('exchange-error').textContent).toBe(
      'must keep exactly 10 distinct cards',
    );
    expect(app.getByTestId('exchange-picker').dataset.locked).toBeUndefined();
    fireEvent.click(confirmButton(app));
    expect(sentDiscards(client)).toHaveLength(2);
  });

  it('supports the 16-card slam hand through maxKeep (M6 wiring)', () => {
    // 16 held, keep 10: the target becomes 6 — the component takes it from
    // the card count, and maxKeep pins the kept size explicitly.
    const sixteen = [...HAND15, makeCard(1, 8)];
    const onConfirm = vi.fn();
    const app = render(<ExchangePicker cards={sixteen} maxKeep={10} locked={false} onConfirm={onConfirm} />);

    const cards = [...app.container.querySelectorAll('button.exchange-card')] as HTMLButtonElement[];
    expect(cards).toHaveLength(16);
    for (const button of cards.slice(0, 5)) fireEvent.click(button);
    expect(app.getByTestId('exchange-count').textContent).toContain('5/6 selected');
    expect((app.getByTestId('exchange-confirm') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(cards[5] as HTMLButtonElement);
    expect((app.getByTestId('exchange-confirm') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(app.getByTestId('exchange-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]?.[0]).toHaveLength(10);
  });
});
