// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  type RedactedView,
  JOKER,
  NULLA,
  NUM,
  bid,
  makeCard,
} from '@five-hundred/engine';
import { cardLabel } from '../components/Card.tsx';
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

/** Seat the four names used across the specs: you, right, partner, left. */
const NAMES_ROOM = roomViewFixture({
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
 * Mid-trick fixture: hearts contract (8H, stake 300) by Cleo (seat 2), who
 * led A♠; the bot (seat 3) followed with 5♠; the viewer (seat 0) holds the
 * turn. Viewer's hand exercises the display sort: trump group with the left
 * bower (J♦) inside it, joker rightmost.
 */
function midTrickView(overrides: Partial<RedactedView> = {}): RedactedView {
  return {
    seat: 0,
    phase: 'play',
    handNumber: 2,
    dealer: 1,
    toAct: 0,
    hand: [
      makeCard(3, 14), // AH
      makeCard(2, 11), // JD — left bower
      JOKER,
      makeCard(3, 11), // JH — right bower
      makeCard(0, 13), // KS
      makeCard(1, 7), // 7C
    ],
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
        { seat: 2, card: makeCard(0, 14) }, // AS
        { seat: 3, card: makeCard(0, 5) }, // 5S
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

function renderTable(view: RedactedView): { client: TestClient; app: ReturnType<typeof renderApp> } {
  const client = makeClient();
  const app = renderApp(client);
  applyEvent(client, env(0, { t: 'roomState', room: NAMES_ROOM }));
  applyEvent(client, env(1, { t: 'gameView', view: { view } }));
  return { client, app };
}

function seatEl(app: ReturnType<typeof renderApp>, seat: number): HTMLElement {
  const el = app.container.querySelector(`[data-seat="${seat}"]`);
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

describe('Table', () => {
  it('renders the mid-trick fixture: sorted hand, backs+counts, trick, HUD (AC-1)', () => {
    const { app } = renderTable(midTrickView());

    // Hand order: trump group (JH, JD left bower, AH), then S, D, C, joker last.
    const hand = app.getByTestId('my-hand');
    const labels = [...hand.querySelectorAll('[data-card]')].map((el) =>
      cardLabel(Number(el.getAttribute('data-card'))),
    );
    expect(labels).toEqual(['J♥', 'J♦', 'A♥', 'K♠', '7♣', 'Joker']);

    // The other three seats show backs with their hidden-hand counts.
    for (const [seat, count] of [
      [1, 7],
      [2, 6],
      [3, 6],
    ] as const) {
      const badge = seatEl(app, seat);
      expect(badge.querySelector('.card-back')).not.toBeNull();
      expect(badge.querySelector('.seat-count')?.textContent).toBe(String(count));
    }
    // The viewer's own seat shows the hand itself, not backs.
    expect(seatEl(app, 0).querySelector('.seat-backs')).toBeNull();

    // Trick cards land by relative seat: Cleo (partner, top) led A♠,
    // the bot on the right played 5♠.
    const trick = app.getByTestId('trick-area');
    const played = [...trick.querySelectorAll('.trick-card')] as HTMLElement[];
    expect(played).toHaveLength(2);
    expect(played[0]?.dataset.seat).toBe('2');
    expect(played[0]?.className).toContain('trick-top');
    expect(played[0]?.querySelector('svg')?.getAttribute('aria-label')).toBe('A♠');
    expect(played[1]?.dataset.seat).toBe('3');
    expect(played[1]?.className).toContain('trick-right');
    expect(played[1]?.querySelector('svg')?.getAttribute('aria-label')).toBe('5♠');

    // HUD: contract by declarer name, Us/Them tricks, scores, stake.
    expect(app.getByTestId('hud-contract').textContent).toBe('8H by Cleo');
    expect(app.getByTestId('hud-tricks').textContent).toBe('Us 3 – Them 2');
    expect(app.getByTestId('hud-scores').textContent).toBe('Score 180 / -40');
    expect(app.getByTestId('hud-stake').textContent).toBe('At stake: 300');
  });

  it('orients Us/Them to the viewer side', () => {
    const { app } = renderTable(midTrickView({ seat: 1, toAct: 1 }));
    expect(app.getByTestId('hud-tricks').textContent).toBe('Us 2 – Them 3');
    expect(app.getByTestId('hud-scores').textContent).toBe('Score -40 / 180');
  });

  it('turn highlight and dealer marker track toAct and dealer (AC-2)', () => {
    const first = renderTable(midTrickView());
    expect(seatEl(first.app, 0).querySelector('[data-acting]')).not.toBeNull();
    expect(seatEl(first.app, 3).querySelector('[data-acting]')).toBeNull();
    expect(seatEl(first.app, 1).querySelector('[data-dealer]')).not.toBeNull();
    expect(seatEl(first.app, 0).querySelector('[data-dealer]')).toBeNull();
    first.app.unmount();

    // Same fixture with the turn and deal moved: the markers follow.
    const second = renderTable(midTrickView({ toAct: 3, dealer: 2 }));
    expect(seatEl(second.app, 0).querySelector('[data-acting]')).toBeNull();
    expect(seatEl(second.app, 3).querySelector('[data-acting]')).not.toBeNull();
    expect(seatEl(second.app, 1).querySelector('[data-dealer]')).toBeNull();
    expect(seatEl(second.app, 2).querySelector('[data-dealer]')).not.toBeNull();
  });

  it('shows the declarer partner as sitting out on a nulla (AC-3)', () => {
    // Ben (seat 1) declares nulla; his partner (seat 3) sits the hand out.
    const { app } = renderTable(
      midTrickView({
        contract: bid(NULLA),
        declarer: 1,
        activeSeats: [0, 1, 2],
        toAct: 1,
        trick: null,
        sideTricks: [0, 0],
      }),
    );
    const partner = seatEl(app, 3);
    expect(partner.querySelector('[data-sitting-out]')).not.toBeNull();
    expect(partner.textContent).toContain('Sitting out');
    for (const active of [0, 1, 2]) {
      expect(seatEl(app, active).querySelector('[data-sitting-out]')).toBeNull();
    }
    expect(app.getByTestId('hud-contract').textContent).toBe('NULLA by Ben');
    expect(app.getByTestId('hud-stake').textContent).toBe('At stake: 250');
  });

  it('fans an unnamed room with bot fallbacks and a 15-card exchange pick', () => {
    // No roomState yet (token rejoin straight into a game): names fall back,
    // and the acting seat's hand mounts as the discard picker.
    const client = makeClient();
    const app = renderApp(client);
    const fifteen = Array.from({ length: 15 }, (_, i) => i);
    applyEvent(
      client,
      env(0, {
        t: 'gameView',
        view: gameViewFixture(0, {
          phase: 'middleExchange',
          contract: bid(NUM, 8, 3),
          declarer: 0,
          hand: fifteen,
          handCounts: [15, 10, 10, 10],
          toAct: 0,
        }),
      }),
    );
    expect(app.getByTestId('exchange-picker').querySelectorAll('[data-card]')).toHaveLength(15);
    expect(app.getByTestId('hud-contract').textContent).toBe('8H by Bot 1');
  });
});
