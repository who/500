// @vitest-environment jsdom

import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { type RedactedView, NT, NUM, bid, makeCard } from '@five-hundred/engine';
import { SlamPanel, slamStake } from './SlamPanel.tsx';
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

// Ana's 15 after the pickup: every spade plus four low clubs.
const SPADES = Array.from({ length: 11 }, (_, i) => makeCard(0, 4 + i));
const CLUBS = [makeCard(1, 4), makeCard(1, 5), makeCard(1, 6), makeCard(1, 7)];
const HAND15 = [...SPADES, ...CLUBS];

function slamView(overrides: Partial<RedactedView> = {}): RedactedView {
  return {
    seat: 0,
    phase: 'slamDecision',
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

function renderOffer(view = slamView()) {
  const client = makeClient();
  const app = renderApp(client);
  applyEvent(client, env(0, { t: 'roomState', room: ROOM }));
  applyEvent(client, env(1, { t: 'gameView', view: { view } }));
  applyEvent(
    client,
    env(2, {
      t: 'actionRequest',
      seat: 0,
      actions: [
        { type: 'declareSlam', seat: 0 },
        { type: 'declineSlam', seat: 0 },
      ],
    }),
  );
  return { client, app };
}

function slamCommands(client: TestClient) {
  return client.sent.filter((c) => c.t === 'declareSlam' || c.t === 'declineSlam');
}

describe('SlamPanel', () => {
  it('words the offer with the exact all-or-nothing stake per contract (AC-1)', () => {
    // 8H is worth 300, so the slam stake is 550.
    const { app } = renderOffer();
    expect(app.getByTestId('slam-offer-text').textContent).toBe(
      'Declare slam — play alone for all 10 tricks: +550 or -550',
    );

    // Other rungs of the ladder: 7S (140) → 390, 10NT (520) → 770.
    expect(slamStake(bid(NUM, 7, 0))).toBe(390);
    expect(slamStake(bid(NUM, 10, NT))).toBe(770);
    const standalone = render(
      <SlamPanel contract={bid(NUM, 7, 0)} locked={false} onDeclare={() => {}} onDecline={() => {}} />,
    );
    expect(
      standalone.container.querySelector('[data-testid="slam-offer-text"]')?.textContent,
    ).toContain('+390 or -390');
  });

  it('requires the confirm step before declareSlam goes out, then locks (AC-1)', () => {
    const { client, app } = renderOffer();

    // First tap only opens the confirm step — nothing sent yet.
    fireEvent.click(app.getByTestId('slam-declare'));
    expect(slamCommands(client)).toHaveLength(0);
    expect(app.getByTestId('slam-confirm')).toBeDefined();

    // Back returns to the offer without sending.
    fireEvent.click(app.getByTestId('slam-back'));
    expect(slamCommands(client)).toHaveLength(0);

    // Declare → confirm sends exactly one declareSlam and locks the panel.
    fireEvent.click(app.getByTestId('slam-declare'));
    fireEvent.click(app.getByTestId('slam-confirm'));
    expect(slamCommands(client)).toEqual([{ t: 'declareSlam' }]);
    expect(app.getByTestId('slam-panel').dataset.locked).toBe('true');
    fireEvent.click(app.getByTestId('slam-confirm'));
    expect(slamCommands(client)).toHaveLength(1);
  });

  it('declines with an explicit declineSlam and proceeds to the normal 15-card discard (AC-1)', () => {
    const { client, app } = renderOffer();
    fireEvent.click(app.getByTestId('slam-decline'));
    expect(slamCommands(client)).toEqual([{ t: 'declineSlam' }]);

    // The next view lands in the ordinary exchange: panel gone, picker up.
    applyEvent(
      client,
      env(3, { t: 'gameView', view: { view: slamView({ phase: 'middleExchange' }) } }),
    );
    applyEvent(
      client,
      env(4, {
        t: 'actionRequest',
        seat: 0,
        actions: [{ type: 'discardKeeps', seat: 0, keeps: [] }],
      }),
    );
    expect(app.queryByTestId('slam-panel')).toBeNull();
    expect(app.getByTestId('exchange-count').textContent).toContain('tap 5 cards to discard');
  });

  it('shows the other seats only that the declarer is considering', () => {
    const client = makeClient();
    const app = renderApp(client);
    applyEvent(client, env(0, { t: 'roomState', room: ROOM }));
    applyEvent(
      client,
      env(1, {
        t: 'gameView',
        view: {
          view: slamView({ seat: 1, hand: CLUBS, handCounts: [15, 10, 10, 10] }),
        },
      }),
    );
    expect(app.queryByTestId('slam-panel')).toBeNull();
    expect(app.getByTestId('slam-status').textContent).toBe('Ana is considering a slam…');
  });

  it('runs the post-slam discard as keep-10-of-16 with the partner sat out (AC-3)', () => {
    // After the slam: Ana holds 16 (partner card in), Cleo (seat 2) is down
    // to 9 and sitting out for the rest of the hand.
    const sixteen = [...HAND15, makeCard(1, 8)];
    const client = makeClient();
    const app = renderApp(client);
    applyEvent(client, env(0, { t: 'roomState', room: ROOM }));
    applyEvent(
      client,
      env(1, {
        t: 'gameView',
        view: {
          view: slamView({
            phase: 'middleExchange',
            slam: true,
            hand: sixteen,
            handCounts: [16, 10, 9, 10],
            activeSeats: [0, 1, 3],
          }),
        },
      }),
    );
    applyEvent(
      client,
      env(2, {
        t: 'actionRequest',
        seat: 0,
        actions: [{ type: 'discardKeeps', seat: 0, keeps: [] }],
      }),
    );

    // 16 held, keep 10: the picker asks for 6 discards under the slam intro.
    expect(app.getByTestId('exchange-count').textContent).toContain(
      'Slam — your partner gave you their best card — tap 6 cards to discard',
    );
    const cards = [
      ...app.getByTestId('exchange-picker').querySelectorAll('button.exchange-card'),
    ] as HTMLButtonElement[];
    expect(cards).toHaveLength(16);
    for (const button of cards.slice(0, 6)) fireEvent.click(button);
    fireEvent.click(app.getByTestId('exchange-confirm'));
    const sent = client.sent.filter((c) => c.t === 'discardKeeps');
    expect(sent).toHaveLength(1);
    expect((sent[0] as { keeps: readonly number[] }).keeps).toHaveLength(10);

    // The sat-out partner reads as such on this client too.
    const partnerSeat = app.container.querySelector('[data-seat="2"] .seat-badge');
    expect(partnerSeat?.getAttribute('data-sitting-out')).toBe('true');
    expect(partnerSeat?.textContent).toContain('Sitting out (slam)');
  });
});
