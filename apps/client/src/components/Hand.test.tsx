// @vitest-environment jsdom

import { act } from 'react';
import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Action,
  type RedactedView,
  JOKER,
  NT,
  NUM,
  bid,
  makeCard,
} from '@five-hundred/engine';
import type { ClientCommand } from '@five-hundred/protocol';
import { JOKER_LEAD_REASON, playLegality } from '../lib/playLegality.ts';
import { LONG_PRESS_MS } from './Hand.tsx';
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

afterEach(() => {
  vi.useRealTimers();
});

const AH = makeCard(3, 14);
const JD = makeCard(2, 11); // left bower under hearts
const KS = makeCard(0, 13);
const SIX_S = makeCard(0, 6);
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

/**
 * Cannot-follow fixture: hearts contract by Cleo (seat 2), who led A♠; the
 * bot followed with 5♠. The viewer (seat 0) must follow spades and holds two
 * followers (K♠, 6♠) among six cards — the joker counts as trump here, so it
 * dims like the other non-spades.
 */
function playView(overrides: Partial<RedactedView> = {}): RedactedView {
  return {
    seat: 0,
    phase: 'play',
    handNumber: 2,
    dealer: 1,
    toAct: 0,
    hand: [AH, JD, JOKER, KS, SIX_S, SEVEN_C],
    handCounts: [6, 7, 6, 6],
    middleCount: 0,
    discardCount: 5,
    contract: bid(NUM, 8, 3),
    declarer: 2,
    slam: false,
    activeSeats: [0, 1, 2, 3],
    auction: null,
    trick: {
      leader: 2,
      ledSuit: 0,
      plays: [
        { seat: 2, card: makeCard(0, 14) }, // A♠
        { seat: 3, card: makeCard(0, 5) }, // 5♠
      ],
    },
    lastTrick: null,
    sideTricks: [3, 2],
    tricksPlayed: 5,
    scores: [180, -40],
    winner: null,
    handResult: null,
    ...overrides,
  };
}

const playAction = (card: number): Action => ({ type: 'playCard', seat: 0, card });
const LEGAL_ACTIONS: readonly Action[] = [playAction(KS), playAction(SIX_S)];

function renderPlayTurn(view = playView(), actions = LEGAL_ACTIONS) {
  const client = makeClient();
  const app = renderApp(client);
  applyEvent(client, env(0, { t: 'roomState', room: ROOM }));
  applyEvent(client, env(1, { t: 'gameView', view: { view } }));
  applyEvent(client, env(2, { t: 'actionRequest', seat: 0, actions }));
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

describe('Hand play interaction', () => {
  it('dims cards outside the legal set and plays those inside on tap (AC-1)', () => {
    const { client, app } = renderPlayTurn();

    for (const legal of [KS, SIX_S]) {
      const button = cardButton(app, legal);
      expect(button.dataset.illegal).toBeUndefined();
      expect(button.getAttribute('aria-disabled')).toBeNull();
    }
    for (const illegal of [AH, JD, JOKER, SEVEN_C]) {
      const button = cardButton(app, illegal);
      expect(button.dataset.illegal).toBe('true');
      expect(button.getAttribute('aria-disabled')).toBe('true');
    }

    // Illegal cards are unclickable; a legal card plays.
    fireEvent.click(cardButton(app, AH));
    fireEvent.click(cardButton(app, SEVEN_C));
    expect(sentPlays(client)).toHaveLength(0);
    fireEvent.click(cardButton(app, KS));
    expect(sentPlays(client)).toEqual([{ t: 'playCard', card: KS }]);
  });

  it('shows a follow-suit reason on the dimmed cards (AC-2)', () => {
    const { app } = renderPlayTurn();
    // Joker included: under a trump contract it is trump, not a spade.
    for (const illegal of [AH, JD, JOKER, SEVEN_C]) {
      expect(cardButton(app, illegal).title).toBe('You must follow spades (♠).');
    }
    // Legal cards keep their plain hover label.
    expect(cardButton(app, KS).title).toBe('K♠');
  });

  it('reveals the reason in a popover on long-press (AC-2, touch)', () => {
    vi.useFakeTimers();
    const { app } = renderPlayTurn();
    const dimmed = cardButton(app, AH);

    fireEvent.touchStart(dimmed);
    expect(app.queryByTestId('card-reason')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(app.getByTestId('card-reason').textContent).toBe('You must follow spades (♠).');
    fireEvent.touchEnd(dimmed);
    expect(app.queryByTestId('card-reason')).toBeNull();

    // Lifting before the threshold never shows the popover.
    fireEvent.touchStart(dimmed);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS - 100);
    });
    fireEvent.touchEnd(dimmed);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(app.queryByTestId('card-reason')).toBeNull();
  });

  it('locks after a play until the next view; the resolved trick highlights the winner (AC-3)', () => {
    const { client, app } = renderPlayTurn();

    fireEvent.click(cardButton(app, KS));
    expect(app.getByTestId('my-hand').dataset.locked).toBe('true');
    // Second tap on a still-legal card is swallowed by the lock.
    fireEvent.click(cardButton(app, SIX_S));
    expect(sentPlays(client)).toEqual([{ t: 'playCard', card: KS }]);

    // Server wave for the completed trick: trickResolved, then the fresh
    // gameView (Cleo's A♠ won), then the next seat's actionRequest.
    const resolved = {
      leader: 2,
      ledSuit: 0,
      plays: [
        { seat: 2, card: makeCard(0, 14) },
        { seat: 3, card: makeCard(0, 5) },
        { seat: 0, card: KS },
        { seat: 1, card: makeCard(0, 12) },
      ],
      winner: 2,
    };
    applyEvent(client, env(3, { t: 'trickResolved', trick: resolved }));
    applyEvent(
      client,
      env(4, {
        t: 'gameView',
        view: {
          view: playView({
            hand: [AH, JD, JOKER, SIX_S, SEVEN_C],
            handCounts: [5, 6, 5, 5],
            toAct: 2,
            trick: { leader: 2, ledSuit: null, plays: [] },
            lastTrick: resolved,
            sideTricks: [3, 3],
            tricksPlayed: 6,
          }),
        },
      }),
    );
    applyEvent(client, env(5, { t: 'actionRequest', seat: 0, actions: [] }));

    // Unlocked again, and with the turn elsewhere nothing is dimmed.
    expect(app.getByTestId('my-hand').dataset.locked).toBeUndefined();
    expect(app.getByTestId('my-hand').querySelector('[data-illegal]')).toBeNull();
    fireEvent.click(cardButton(app, SIX_S));
    expect(sentPlays(client)).toHaveLength(1);

    // The resolved trick stays up, plays by seat, winner highlighted.
    const trick = app.getByTestId('trick-area');
    const played = [...trick.querySelectorAll('.trick-card')] as HTMLElement[];
    expect(played.map((p) => p.dataset.seat)).toEqual(['2', '3', '0', '1']);
    const winner = trick.querySelector('[data-winner]') as HTMLElement;
    expect(winner.dataset.seat).toBe('2');
    expect(winner.className).toContain('trick-winner');
    expect(winner.querySelector('svg')?.getAttribute('aria-label')).toBe('A♠');
    expect(trick.querySelectorAll('[data-winner]')).toHaveLength(1);
  });

  it('marks an acting bot seat as thinking, but never a human', () => {
    // Turn on the bot at seat 3.
    const { app } = renderPlayTurn(playView({ toAct: 3 }), []);
    const bot = app.container.querySelector('[data-seat="3"] [data-testid="seat-thinking"]');
    expect(bot?.textContent).toBe('thinking…');

    // A human acting seat (the viewer) shows no thinking hint.
    const human = renderPlayTurn();
    expect(human.app.container.querySelector('[data-testid="seat-thinking"]')).toBeNull();
  });
});

describe('playLegality', () => {
  it('is inert off-turn, off-phase, and without playCard actions', () => {
    expect(playLegality(playView({ toAct: 2 }), LEGAL_ACTIONS).active).toBe(false);
    expect(playLegality(playView({ phase: 'auction' }), LEGAL_ACTIONS).active).toBe(false);
    expect(playLegality(playView(), null).active).toBe(false);
    expect(playLegality(playView(), []).active).toBe(false);
  });

  it('blocks a joker lead in no-trump with the picker placeholder reason', () => {
    // Leading in 8NT holding the joker: the server expands the joker into
    // four jokerSuit actions; without the M6 picker the card stays blocked.
    const view = playView({
      contract: bid(NUM, 8, NT),
      trick: { leader: 0, ledSuit: null, plays: [] },
      hand: [AH, JOKER, SEVEN_C],
    });
    const actions: Action[] = [
      playAction(AH),
      playAction(SEVEN_C),
      ...[0, 1, 2, 3].map((s): Action => ({ type: 'playCard', seat: 0, card: JOKER, jokerSuit: s })),
    ];
    const result = playLegality(view, actions);
    expect(result.active).toBe(true);
    expect([...result.legal].sort((a, b) => a - b)).toEqual([SEVEN_C, AH].sort((a, b) => a - b));
    expect(result.reasons.get(JOKER)).toBe(JOKER_LEAD_REASON);
  });

  it('falls back to the generic reason when no follow explanation applies', () => {
    // NT, following clubs, holding the joker: the joker always follows, so
    // the other cards must follow clubs; a hypothetical illegal follower
    // (server-legal-set says no, view says it follows) gets the generic text.
    const view = playView({
      contract: bid(NUM, 8, NT),
      trick: { leader: 2, ledSuit: 1, plays: [{ seat: 2, card: makeCard(1, 14) }] },
      hand: [AH, JOKER, SEVEN_C],
    });
    const result = playLegality(view, [playAction(JOKER)]);
    expect(result.reasons.get(AH)).toBe('You must follow clubs (♣).');
    // 7♣ follows clubs but sits outside the (fixture) legal set → generic.
    expect(result.reasons.get(SEVEN_C)).toBe('Not legal right now.');
  });
});
