// @vitest-environment jsdom

/**
 * Joker UX (PRD 6.2): leading the joker under no trump opens the suit
 * picker and submits playCard with the chosen jokerSuit (AC-1); merely
 * playing it to a led trick never prompts; a hand void in the led suit but
 * holding the joker shows the sluff-block reason on its dimmed cards (AC-2);
 * a led joker renders with its declared-suit chip (AC-3).
 */

import { fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Action,
  type RedactedView,
  type Trick,
  JOKER,
  NT,
  NUM,
  bid,
  makeCard,
} from '@five-hundred/engine';
import type { ClientCommand } from '@five-hundred/protocol';
import { JOKER_SLUFF_REASON } from '../lib/playLegality.ts';
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

const AH = makeCard(3, 14);
const KS = makeCard(0, 13);
const SEVEN_C = makeCard(1, 7);

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

/** 8NT by the viewer (seat 0), about to lead: the joker needs a named suit. */
function ntView(overrides: Partial<RedactedView> = {}): RedactedView {
  return {
    seat: 0,
    phase: 'play',
    handNumber: 2,
    dealer: 1,
    redeals: 0,
    toAct: 0,
    hand: [AH, JOKER, SEVEN_C],
    handCounts: [3, 4, 3, 3],
    middleCount: 0,
    discardCount: 5,
    contract: bid(NUM, 8, NT),
    declarer: 0,
    slam: false,
    activeSeats: [0, 1, 2, 3],
    auction: null,
    trick: { leader: 0, ledSuit: null, plays: [] },
    lastTrick: null,
    sideTricks: [4, 3],
    tricksPlayed: 7,
    scores: [180, -40],
    winner: null,
    handResult: null,
    ...overrides,
  };
}

const playAction = (card: number): Action => ({ type: 'playCard', seat: 0, card });
const JOKER_LEAD_ACTIONS: readonly Action[] = [
  playAction(AH),
  playAction(SEVEN_C),
  ...[0, 1, 2, 3].map((s): Action => ({ type: 'playCard', seat: 0, card: JOKER, jokerSuit: s })),
];

function renderPlayTurn(view: RedactedView, actions: readonly Action[]) {
  const client = makeClient();
  const app = renderApp(client);
  applyEvent(client, env(0, { t: 'roomState', room: ROOM }));
  applyEvent(client, env(1, { t: 'gameView', view: { view } }));
  applyEvent(client, env(2, { t: 'actionRequest', seat: 0, actions: [...actions] }));
  return { client, app };
}

function cardButton(app: ReturnType<typeof renderApp>, card: number): HTMLButtonElement {
  const buttons = [...app.getByTestId('my-hand').querySelectorAll('button.hand-card')];
  const match = buttons.find(
    (b) => b.querySelector('[data-card]')?.getAttribute('data-card') === String(card),
  );
  expect(match).toBeDefined();
  return match as HTMLButtonElement;
}

function sentPlays(client: TestClient): ClientCommand[] {
  return client.sent.filter((c) => c.t === 'playCard');
}

describe('joker lead suit picker (AC-1)', () => {
  it('opens on tapping the joker to lead and submits the chosen jokerSuit', () => {
    const { client, app } = renderPlayTurn(ntView(), JOKER_LEAD_ACTIONS);

    // The joker is playable, not dimmed, despite arriving only as variants.
    expect(cardButton(app, JOKER).dataset.illegal).toBeUndefined();

    fireEvent.click(cardButton(app, JOKER));
    const picker = app.getByTestId('joker-suit-picker');
    // Opening the picker submits nothing and keeps the hand unlocked.
    expect(sentPlays(client)).toHaveLength(0);
    expect(app.getByTestId('my-hand').dataset.locked).toBeUndefined();

    fireEvent.click(picker.querySelector('[data-suit="3"]') as HTMLButtonElement);
    expect(sentPlays(client)).toEqual([{ t: 'playCard', card: JOKER, jokerSuit: 3 }]);
    expect(app.queryByTestId('joker-suit-picker')).toBeNull();
    expect(app.getByTestId('my-hand').dataset.locked).toBe('true');
  });

  it('cancel closes the picker with the turn still open', () => {
    const { client, app } = renderPlayTurn(ntView(), JOKER_LEAD_ACTIONS);

    fireEvent.click(cardButton(app, JOKER));
    fireEvent.click(
      app
        .getByTestId('joker-suit-picker')
        .querySelector('.joker-picker-cancel') as HTMLButtonElement,
    );
    expect(app.queryByTestId('joker-suit-picker')).toBeNull();
    expect(sentPlays(client)).toHaveLength(0);

    // The hand stayed interactive: another card still plays normally.
    fireEvent.click(cardButton(app, AH));
    expect(sentPlays(client)).toEqual([{ t: 'playCard', card: AH }]);
  });

  it('renders on the felt, outside the hand fan (fh-rtr)', () => {
    const { app } = renderPlayTurn(ntView(), JOKER_LEAD_ACTIONS);

    fireEvent.click(cardButton(app, JOKER));
    const picker = app.getByTestId('joker-suit-picker');
    // The felt (.game-table) is the positioning ancestor, so the fanned,
    // rotated cards in .my-hand can never establish a context above it.
    expect(picker.closest('.game-table')).not.toBeNull();
    expect(picker.closest('.my-hand')).toBeNull();
    expect(picker.classList.contains('joker-picker')).toBe(true);
  });

  it('closes when the turn moves on while it is open', () => {
    const { client, app } = renderPlayTurn(ntView(), JOKER_LEAD_ACTIONS);

    fireEvent.click(cardButton(app, JOKER));
    expect(app.getByTestId('joker-suit-picker')).toBeDefined();

    // A newer view hands the turn to seat 1 (and supersedes the request).
    applyEvent(client, env(3, { t: 'gameView', view: { view: ntView({ toAct: 1 }) } }));
    expect(app.queryByTestId('joker-suit-picker')).toBeNull();
    expect(sentPlays(client)).toHaveLength(0);
  });

  it('closes when playing another card locks the hand', () => {
    const { client, app } = renderPlayTurn(ntView(), JOKER_LEAD_ACTIONS);

    fireEvent.click(cardButton(app, JOKER));
    fireEvent.click(cardButton(app, AH));
    expect(sentPlays(client)).toEqual([{ t: 'playCard', card: AH }]);
    expect(app.getByTestId('my-hand').dataset.locked).toBe('true');
    expect(app.queryByTestId('joker-suit-picker')).toBeNull();
  });

  it('never prompts when following with the joker', () => {
    // Clubs led; the joker follows silently (it assumes the led suit).
    const view = ntView({
      toAct: 0,
      trick: { leader: 2, ledSuit: 1, plays: [{ seat: 2, card: makeCard(1, 14) }] },
    });
    const { client, app } = renderPlayTurn(view, [playAction(JOKER)]);

    fireEvent.click(cardButton(app, JOKER));
    expect(app.queryByTestId('joker-suit-picker')).toBeNull();
    expect(sentPlays(client)).toEqual([{ t: 'playCard', card: JOKER }]);
  });

  it('never prompts when leading the joker in a trump contract', () => {
    // 8♥: the joker is just top trump, so the server sends a plain action.
    const view = ntView({ contract: bid(NUM, 8, 3) });
    const { client, app } = renderPlayTurn(view, [
      playAction(AH),
      playAction(SEVEN_C),
      playAction(JOKER),
    ]);

    fireEvent.click(cardButton(app, JOKER));
    expect(app.queryByTestId('joker-suit-picker')).toBeNull();
    expect(sentPlays(client)).toEqual([{ t: 'playCard', card: JOKER }]);
  });
});

describe('joker sluff-block explanation (AC-2)', () => {
  it('shows the exact sluff-block reason on dimmed off-suit cards', () => {
    // Spades led, no natural spade in hand: the joker is the only follower,
    // so the rest of the hand dims with the joker rule, not the follow text.
    const view = ntView({
      trick: { leader: 2, ledSuit: 0, plays: [{ seat: 2, card: makeCard(0, 14) }] },
    });
    const { app } = renderPlayTurn(view, [playAction(JOKER)]);

    for (const blocked of [AH, SEVEN_C]) {
      const button = cardButton(app, blocked);
      expect(button.dataset.illegal).toBe('true');
      expect(button.title).toBe(JOKER_SLUFF_REASON);
    }
    expect(cardButton(app, JOKER).dataset.illegal).toBeUndefined();
  });
});

describe('led-joker declared-suit chip (AC-3)', () => {
  it('chips the led joker with its named suit on the trick in progress', () => {
    // Cleo (seat 2) led the joker declaring hearts; the viewer sees the chip.
    const view = ntView({
      toAct: 0,
      hand: [AH, KS, SEVEN_C],
      trick: { leader: 2, ledSuit: 3, plays: [{ seat: 2, card: JOKER }] },
    });
    const { app } = renderPlayTurn(view, [playAction(AH)]);

    const chip = app.getByTestId('joker-declares');
    expect(chip.textContent).toBe('declares ♥');
    expect(chip.closest('.trick-card')?.getAttribute('data-seat')).toBe('2');
  });

  it('keeps the chip on the resolved trick until the next lead', () => {
    const resolved: Trick = {
      leader: 2,
      ledSuit: 3,
      plays: [
        { seat: 2, card: JOKER },
        { seat: 3, card: makeCard(3, 5) },
        { seat: 0, card: makeCard(3, 6) },
        { seat: 1, card: makeCard(3, 7) },
      ],
      winner: 2,
    };
    const view = ntView({
      toAct: 2,
      hand: [AH, KS],
      trick: { leader: 2, ledSuit: null, plays: [] },
      lastTrick: resolved,
    });
    const { app } = renderPlayTurn(view, []);
    expect(app.getByTestId('joker-declares').textContent).toBe('declares ♥');
  });

  it('shows no chip for a joker that followed or led as plain trump', () => {
    // Followed to a spade lead in NT: silent, no named suit.
    const followed = ntView({
      toAct: 0,
      hand: [AH, KS, SEVEN_C],
      trick: {
        leader: 2,
        ledSuit: 0,
        plays: [
          { seat: 2, card: makeCard(0, 14) },
          { seat: 3, card: JOKER },
        ],
      },
    });
    const { app } = renderPlayTurn(followed, [playAction(KS)]);
    expect(app.queryByTestId('joker-declares')).toBeNull();

    // Led under an 8♥ contract: it is trump, never a declared suit.
    const trumpLed = ntView({
      contract: bid(NUM, 8, 3),
      toAct: 0,
      hand: [AH, KS, SEVEN_C],
      trick: { leader: 2, ledSuit: 3, plays: [{ seat: 2, card: JOKER }] },
    });
    const second = renderPlayTurn(trumpLed, []);
    expect(second.app.queryByTestId('joker-declares')).toBeNull();
  });
});
