// @vitest-environment jsdom

import { act } from 'react';
import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RedactedView, DNULLA, JOKER, NULLA, NUM, bid, makeCard } from '@five-hundred/engine';
import { cardLabel } from '../components/Card.tsx';
import { CONTRACT_TOAST_MS } from '../components/ContractToast.tsx';
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

afterEach(() => {
  vi.useRealTimers();
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

  it('a turn handoff re-renders every badge in place — no remount (fh-jbs AC-3)', () => {
    // A remounted badge replays its 180ms border transition from the default
    // color, which flashes; the same DOM nodes must survive the gameView
    // update that moves toAct.
    const { client, app } = renderTable(midTrickView());
    const badges = [0, 1, 2, 3].map((s) => seatEl(app, s).querySelector('.seat-badge'));
    applyEvent(client, env(2, { t: 'gameView', view: { view: midTrickView({ toAct: 3 }) } }));
    for (const [s, badge] of badges.entries()) {
      expect(badge?.isConnected).toBe(true);
      expect(seatEl(app, s).querySelector('.seat-badge')).toBe(badge);
    }
    expect(badges[0]?.matches('.acting')).toBe(false);
    expect(badges[3]?.matches('.acting')).toBe(true);
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
    // That forced trick already sets a nulla, so the counter says so (fh-d2d).
    expect(app.getByTestId('hud-tricks').textContent).toBe(
      'Tricks taken by bidders: 1 — they want 0 — bidders set',
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

  it('flags the trick on screen from the debug panel below the hand (fh-q2m)', () => {
    // The mid-trick fixture is hand 2, trick index 5 (5 tricks already played
    // and one in progress) — exactly what the marker must carry.
    const { client, app } = renderTable(midTrickView());

    const panel = app.getByTestId('debug-panel');
    expect(app.getByTestId('my-hand').compareDocumentPosition(panel)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    fireEvent.click(app.getByTestId('debug-toggle'));
    fireEvent.change(app.getByTestId('flag-note'), { target: { value: 'bot ducked its ace' } });
    fireEvent.click(app.getByTestId('flag-trick'));

    expect(client.sent).toEqual([
      { t: 'flagTrick', hand: 2, trick: 5, note: 'bot ducked its ace' },
    ]);
    // fh-g4g: the confirmation names the play in 0-based engine seats, which
    // is how the log records it — never the felt's 1-based seat label.
    expect(app.getByTestId('flag-status').textContent).toBe(
      'Flagged hand 3, trick 6 — seat 3 played 5S',
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
    expect(app.getByTestId('hud-contract').textContent).toBe('8H by Seat 1');
  });
});

/**
 * Mount mid-auction (no contract yet), then land the view the server sends
 * the instant the auction resolves — `contract` going null -> set is exactly
 * what the announcement watches.
 */
function winAuction(
  seat: number,
  resolved: Partial<RedactedView>,
): { client: TestClient; app: ReturnType<typeof renderApp> } {
  const client = makeClient();
  const app = renderApp(client);
  applyEvent(client, env(0, { t: 'roomState', room: NAMES_ROOM }));
  applyEvent(client, env(1, { t: 'gameView', view: gameViewFixture(seat, { toAct: 1 }) }));
  applyEvent(client, env(2, { t: 'gameView', view: gameViewFixture(seat, resolved) }));
  return { client, app };
}

/** A NUM contract lands in the slam offer first (engine initExchange). */
const WON_8D = {
  phase: 'slamDecision',
  contract: bid(NUM, 8, 2),
  declarer: 3,
  toAct: 3,
  handCounts: [10, 10, 10, 15],
} as const;

describe('contract-won announcement (fh-8kz)', () => {
  it('announces the winner and contract for a bot declarer and for you (AC-1)', () => {
    // A bot wins: the human is a defender and would otherwise see nothing but
    // the bot's silent middle exchange before trick 1.
    const bot = winAuction(0, WON_8D);
    expect(bot.app.getByTestId('contract-toast').textContent).toBe(
      'AI Noah won the bid — 8 Diamonds (280 at stake)',
    );
    bot.app.unmount();

    // The viewer wins: named as "You", never by their own seat name.
    const you = winAuction(0, { ...WON_8D, declarer: 0, toAct: 0, handCounts: [15, 10, 10, 10] });
    expect(you.app.getByTestId('contract-toast').textContent).toBe(
      'You won the bid — 8 Diamonds (280 at stake)',
    );
    you.app.unmount();

    // A reconnect re-baselining mid-hand has no auction to announce: the
    // contract was already there, so nothing "just happened".
    const { app } = renderTable(midTrickView());
    expect(app.queryByTestId('contract-toast')).toBeNull();
  });

  it('spells out nulla, double nulla, and a slam declared after the win (AC-2)', () => {
    const nulla = winAuction(0, {
      phase: 'middleExchange',
      contract: bid(NULLA),
      declarer: 1,
      toAct: 1,
      activeSeats: [0, 1, 2],
    });
    expect(nulla.app.getByTestId('contract-toast').textContent).toBe(
      'Ben won the bid — Nulla (250 at stake)',
    );
    nulla.app.unmount();

    const dnulla = winAuction(0, {
      phase: 'middleExchange',
      contract: bid(DNULLA),
      declarer: 2,
      toAct: 2,
    });
    expect(dnulla.app.getByTestId('contract-toast').textContent).toBe(
      'Cleo won the bid — Double Nulla (500 at stake)',
    );
    dnulla.app.unmount();

    // 10S by Cleo, who then declares the slam while the toast is still up:
    // the announcement reads the live view, so the stake is a flat 500.
    const slam = winAuction(0, {
      phase: 'slamDecision',
      contract: bid(NUM, 10, 0),
      declarer: 2,
      toAct: 2,
    });
    expect(slam.app.getByTestId('contract-toast').textContent).toBe(
      'Cleo won the bid — 10 Spades (440 at stake)',
    );
    applyEvent(
      slam.client,
      env(3, {
        t: 'gameView',
        view: gameViewFixture(0, {
          phase: 'partnerCard',
          contract: bid(NUM, 10, 0),
          declarer: 2,
          toAct: 0,
          slam: true,
        }),
      }),
    );
    expect(slam.app.getByTestId('contract-toast').textContent).toBe(
      'Cleo won the bid — Slam 10 Spades (500 at stake)',
    );
  });

  it('a dead auction toasts the redeal instead, and never both at once (AC-2)', () => {
    const client = makeClient();
    const app = renderApp(client);
    applyEvent(client, env(0, { t: 'roomState', room: NAMES_ROOM }));
    applyEvent(client, env(1, { t: 'gameView', view: gameViewFixture(0, { toAct: 1 }) }));

    // Nobody bid: the redeal toast, and no false "won the bid".
    applyEvent(
      client,
      env(2, { t: 'gameView', view: gameViewFixture(0, { redeals: 1, dealer: 0, toAct: 1 }) }),
    );
    expect(app.queryByTestId('contract-toast')).toBeNull();
    expect(app.getByTestId('redeal-toast').textContent).toBe(
      'No winning bid — redealing. Ana deals.',
    );

    // The re-dealt auction produces a contract: the announcement takes over
    // and the stale redeal toast goes, so the two never stack.
    applyEvent(
      client,
      env(3, { t: 'gameView', view: gameViewFixture(0, { ...WON_8D, redeals: 1, dealer: 0 }) }),
    );
    expect(app.queryByTestId('redeal-toast')).toBeNull();
    expect(app.getByTestId('contract-toast').textContent).toBe(
      'AI Noah won the bid — 8 Diamonds (280 at stake)',
    );
  });

  it('sits clear of the felt and dismisses itself (AC-3)', () => {
    vi.useFakeTimers();
    const { app } = winAuction(0, WON_8D);
    const toast = app.getByTestId('contract-toast');

    // Fixed to the top of the screen, outside the felt's grid entirely: it
    // cannot occlude the trick area or the first lead (fh-1dv stacking).
    expect(toast.closest('.game-table')).toBeNull();
    expect(app.getByTestId('trick-area')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(CONTRACT_TOAST_MS);
    });
    expect(app.queryByTestId('contract-toast')).toBeNull();
  });
});
