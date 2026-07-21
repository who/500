// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { type RedactedView, DNULLA, JOKER, NULLA, NUM, bid, makeCard } from '@five-hundred/engine';
import { cardLabel } from '../components/Card.tsx';
import {
  applyEvent,
  botSeatView,
  env,
  gameViewFixture,
  humanSeatView,
  redactedViewFixture,
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
    redeals: 0,
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

function renderTable(view: RedactedView): {
  client: TestClient;
  app: ReturnType<typeof renderApp>;
} {
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

  it('shows the nulla partner sitting out with lose-all HUD framing (AC-3)', () => {
    // Ben (seat 1) declares nulla; his partner (seat 3) sits the hand out.
    // The defenders have forced one trick onto the bidders (side 1).
    const { app } = renderTable(
      midTrickView({
        contract: bid(NULLA),
        declarer: 1,
        activeSeats: [0, 1, 2],
        toAct: 1,
        trick: null,
        sideTricks: [2, 1],
      }),
    );
    const partner = seatEl(app, 3);
    expect(partner.querySelector('[data-sitting-out]')).not.toBeNull();
    expect(partner.textContent).toContain('Sitting out (nulla)');
    for (const active of [0, 1, 2]) {
      expect(seatEl(app, active).querySelector('[data-sitting-out]')).toBeNull();
    }
    expect(app.getByTestId('hud-contract').textContent).toBe(
      'Nulla 250 by Ben — must lose every trick',
    );
    expect(app.getByTestId('hud-tricks').textContent).toBe(
      'Tricks taken by bidders: 1 — they want 0',
    );
    expect(app.getByTestId('hud-stake').textContent).toBe('At stake: 250');
  });

  it('mounts the dnulla partner picker only after the declarer confirms (AC-2)', () => {
    // Cleo (seat 2) declares double nulla; the viewer (seat 0) is her partner.
    const client = makeClient();
    const app = renderApp(client);
    applyEvent(client, env(0, { t: 'roomState', room: NAMES_ROOM }));
    const declarerDiscarding = {
      phase: 'middleExchange',
      contract: bid(DNULLA),
      declarer: 2,
      toAct: 2,
      hand: Array.from({ length: 10 }, (_, i) => 20 + i),
      handCounts: [10, 10, 15, 10],
      middleCount: 0,
    } as const;
    applyEvent(client, env(1, { t: 'gameView', view: gameViewFixture(0, declarerDiscarding) }));

    // Before the declarer confirms: no picker, the ordinary abstract status,
    // and — dnulla keeps all four seats active — nobody sitting out.
    expect(app.queryByTestId('exchange-picker')).toBeNull();
    expect(app.getByTestId('exchange-status').textContent).toBe(
      'Cleo picked up the middle and is discarding 5…',
    );
    expect(app.getByTestId('hud-contract').textContent).toBe(
      'Double Nulla 500 by Cleo — both must lose every trick',
    );
    for (const seat of [1, 2, 3]) {
      expect(seatEl(app, seat).querySelector('[data-sitting-out]')).toBeNull();
    }

    // Cleo confirms: her 5 discards travel on, the viewer holds 15 and acts.
    applyEvent(
      client,
      env(2, {
        t: 'gameView',
        view: gameViewFixture(0, {
          ...declarerDiscarding,
          toAct: 0,
          hand: Array.from({ length: 15 }, (_, i) => i),
          handCounts: [15, 10, 10, 10],
        }),
      }),
    );
    const picker = app.getByTestId('exchange-picker');
    expect(picker.querySelectorAll('[data-card]')).toHaveLength(15);
    expect(app.getByTestId('exchange-count').textContent).toContain(
      'Your partner passed you 5 cards — tap 5 cards to discard',
    );
  });

  it('shows both dnulla pass-through wait states while the partner discards', () => {
    // Ana (seat 0) is discarding the passed cards; Cleo (seat 2) declared.
    const passThroughView = {
      phase: 'middleExchange',
      contract: bid(DNULLA),
      declarer: 2,
      toAct: 0,
      handCounts: [15, 10, 10, 10],
      middleCount: 0,
    } as const;

    // The declarer sees an explicit "waiting for partner" state.
    const declarer = renderTable(
      redactedViewFixture(2, {
        ...passThroughView,
        hand: Array.from({ length: 10 }, (_, i) => 20 + i),
      }),
    );
    expect(declarer.app.getByTestId('exchange-status').textContent).toBe(
      'You passed 5 cards to Ana — waiting for their discards…',
    );
    declarer.app.unmount();

    // Defenders see the abstract pass event only (no card identities).
    const defender = renderTable(
      redactedViewFixture(1, {
        ...passThroughView,
        hand: Array.from({ length: 10 }, (_, i) => 20 + i),
      }),
    );
    expect(defender.app.getByTestId('exchange-status').textContent).toBe(
      'Cleo passed 5 cards to Ana, who is discarding…',
    );
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
