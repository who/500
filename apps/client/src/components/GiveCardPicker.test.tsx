// @vitest-environment jsdom

import { fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { type RedactedView, JOKER, NUM, bid, makeCard } from '@five-hundred/engine';
import { strongestCard } from './GiveCardPicker.tsx';
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

// Hearts are trump (8H): the left bower J♦ outranks even the trump ace.
const LEFT_BOWER = makeCard(2, 11); // J♦
const TRUMP_ACE = makeCard(3, 14); // A♥
const PLAIN_ACE = makeCard(0, 14); // A♠
const FILLER = [
  makeCard(1, 4),
  makeCard(1, 5),
  makeCard(1, 6),
  makeCard(1, 7),
  makeCard(1, 8),
  makeCard(0, 4),
  makeCard(0, 5),
];
const PARTNER_HAND = [LEFT_BOWER, TRUMP_ACE, PLAIN_ACE, ...FILLER];

function giveView(overrides: Partial<RedactedView> = {}): RedactedView {
  return {
    seat: 2,
    phase: 'partnerCard',
    handNumber: 1,
    dealer: 3,
    redeals: 0,
    toAct: 2,
    hand: PARTNER_HAND,
    handCounts: [15, 10, 10, 10],
    middleCount: 0,
    discardCount: 0,
    contract: bid(NUM, 8, 3),
    declarer: 0,
    slam: true,
    activeSeats: [0, 1, 3],
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

function renderPartner(view = giveView()) {
  const client = makeClient();
  const app = renderApp(client);
  applyEvent(client, env(0, { t: 'roomState', room: ROOM }));
  applyEvent(client, env(1, { t: 'gameView', view: { view } }));
  applyEvent(
    client,
    env(2, {
      t: 'actionRequest',
      seat: 2,
      actions: view.hand.map((card) => ({ type: 'giveCard' as const, seat: 2, card })),
    }),
  );
  return { client, app };
}

function pickerCard(app: ReturnType<typeof renderApp>, card: number): HTMLButtonElement {
  const buttons = [...app.getByTestId('give-card-picker').querySelectorAll('button.exchange-card')];
  const match = buttons.find(
    (b) => b.querySelector('[data-card]')?.getAttribute('data-card') === String(card),
  );
  expect(match).toBeDefined();
  return match as HTMLButtonElement;
}

function sentGives(client: TestClient) {
  return client.sent.filter((c) => c.t === 'giveCard');
}

describe('strongestCard', () => {
  it('rates by cardPower under the contract trump: left bower over trump ace', () => {
    expect(strongestCard(PARTNER_HAND, 3)).toBe(LEFT_BOWER);
  });

  it('always suggests the joker when held', () => {
    expect(strongestCard([...PARTNER_HAND, JOKER], 3)).toBe(JOKER);
  });

  it('falls back to the highest card rated in its own suit under no trump', () => {
    expect(strongestCard([makeCard(1, 4), makeCard(0, 13), makeCard(2, 9)], null)).toBe(
      makeCard(0, 13),
    );
    expect(strongestCard([], 3)).toBeNull();
  });
});

describe('GiveCardPicker', () => {
  it('pre-suggests the strongest card and submits it on confirm (AC-2)', () => {
    const { client, app } = renderPartner();

    expect(app.getByTestId('give-card-status').textContent).toContain('Strongest suggested: J♦');
    expect(pickerCard(app, LEFT_BOWER).dataset.give).toBe('true');
    const confirm = app.getByTestId('give-card-confirm') as HTMLButtonElement;
    expect(confirm.textContent).toBe('Give J♦');
    expect(confirm.disabled).toBe(false);

    fireEvent.click(confirm);
    expect(sentGives(client)).toEqual([{ t: 'giveCard', card: LEFT_BOWER }]);

    // Locked until the next view: no re-pick, no double submit.
    expect(app.getByTestId('give-card-picker').dataset.locked).toBe('true');
    fireEvent.click(pickerCard(app, PLAIN_ACE));
    fireEvent.click(confirm);
    expect(sentGives(client)).toHaveLength(1);
  });

  it('lets the partner override the suggestion with any card (AC-2)', () => {
    const { client, app } = renderPartner();
    const lowClub = FILLER[0] as number;

    fireEvent.click(pickerCard(app, lowClub));
    expect(pickerCard(app, lowClub).dataset.give).toBe('true');
    expect(pickerCard(app, LEFT_BOWER).dataset.give).toBeUndefined();
    expect(app.getByTestId('give-card-confirm').textContent).toBe('Give 4♣');

    fireEvent.click(app.getByTestId('give-card-confirm'));
    expect(sentGives(client)).toEqual([{ t: 'giveCard', card: lowClub }]);
  });

  it('shows the declarer distinct wait copy and the sat-out partner badge (AC-3)', () => {
    // Ana (declarer, seat 0) holds her 15 and waits on Cleo's card.
    const fifteen = Array.from({ length: 11 }, (_, i) => makeCard(0, 4 + i)).concat(
      makeCard(1, 4),
      makeCard(1, 5),
      makeCard(1, 6),
      makeCard(1, 7),
    );
    const client = makeClient();
    const app = renderApp(client);
    applyEvent(client, env(0, { t: 'roomState', room: ROOM }));
    applyEvent(
      client,
      env(1, {
        t: 'gameView',
        view: { view: giveView({ seat: 0, toAct: 2, hand: fifteen }) },
      }),
    );

    expect(app.queryByTestId('give-card-picker')).toBeNull();
    expect(app.getByTestId('slam-status').textContent).toBe(
      'Slam declared — waiting for Cleo to give you their best card…',
    );
    const partnerSeat = app.container.querySelector('[data-seat="2"] .seat-badge');
    expect(partnerSeat?.getAttribute('data-sitting-out')).toBe('true');
    expect(partnerSeat?.textContent).toContain('Sitting out (slam)');
  });

  it('keeps the surrender abstract for the other seats (AC-3)', () => {
    const client = makeClient();
    const app = renderApp(client);
    applyEvent(client, env(0, { t: 'roomState', room: ROOM }));
    applyEvent(
      client,
      env(1, {
        t: 'gameView',
        view: { view: giveView({ seat: 1, hand: FILLER.slice(0, 7) }) },
      }),
    );

    expect(app.queryByTestId('give-card-picker')).toBeNull();
    expect(app.getByTestId('slam-status').textContent).toBe(
      'Cleo is giving their best card to Ana…',
    );
    const partnerSeat = app.container.querySelector('[data-seat="2"] .seat-badge');
    expect(partnerSeat?.getAttribute('data-sitting-out')).toBe('true');
  });
});
