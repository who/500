// @vitest-environment jsdom

/**
 * Auction UX aggregate spec (issue fh-333.4): indication legality on the bid
 * panel (AC-1), per-seat bid-history chips (AC-2), and the redeal toast
 * (AC-3), driven through the Table screen with engine-built auction states so
 * legality and history match what the server would actually send.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Action,
  type AuctionState,
  type Bid,
  IND,
  NUM,
  PASS,
  applyAuctionAction,
  bid,
  bidKey,
  initAuction,
  legalBids,
} from '@five-hundred/engine';
import {
  applyEvent,
  botSeatView,
  env,
  humanSeatView,
  installFakeLocalStorage,
  makeClient,
  redactedViewFixture,
  renderApp,
  roomViewFixture,
} from '../screens/test-helpers.tsx';

beforeEach(() => {
  installFakeLocalStorage();
  history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.useRealTimers();
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

/** Run an auction through the real reducer: `actions` applied in turn order. */
function runAuction(first: number, actions: readonly Bid[]): AuctionState {
  let state = initAuction(first);
  for (const b of actions) state = applyAuctionAction(state, state.turn, b);
  return state;
}

function bidActions(state: AuctionState, seat: number): Action[] {
  return legalBids(state, seat).map((b): Action => ({ type: 'bid', seat, bid: b }));
}

/** Mount the table mid-auction for viewer seat 0 with a full request wave. */
function renderAuction(state: AuctionState, extras: { redeals?: number; dealer?: number } = {}) {
  const client = makeClient();
  const app = renderApp(client);
  applyEvent(client, env(0, { t: 'roomState', room: ROOM }));
  applyEvent(
    client,
    env(1, {
      t: 'gameView',
      view: {
        view: redactedViewFixture(0, {
          phase: 'auction',
          toAct: state.turn,
          auction: state,
          redeals: extras.redeals ?? 0,
          dealer: extras.dealer ?? 3,
        }),
      },
    }),
  );
  applyEvent(
    client,
    env(2, { t: 'actionRequest', seat: state.turn, actions: bidActions(state, state.turn) }),
  );
  return { client, app };
}

function chipsFor(app: ReturnType<typeof renderApp>, seat: number): HTMLElement | null {
  return app.container.querySelector(`[data-seat="${seat}"] [data-testid="bid-history"]`);
}

function chipTexts(el: HTMLElement | null): string[] {
  return [...(el?.querySelectorAll('.bid-chip') ?? [])].map((c) => c.textContent ?? '');
}

describe('auction UX', () => {
  it('enables indication exactly when legal, only pre-winning-bid (AC-1)', () => {
    // Fresh auction: the viewer may indicate — all 5 cells enabled, tooltip on.
    // (Each render mounts its own tree, so queries scope to that container.)
    const fresh = renderAuction(runAuction(0, []));
    const cell = (app: ReturnType<typeof renderApp>, s: number) =>
      app.container.querySelector(
        `button[data-bid="${bidKey(bid(IND, 6, s))}"]`,
      ) as HTMLButtonElement;
    for (let s = 0; s < 5; s++) expect(cell(fresh.app, s).disabled).toBe(false);
    expect(cell(fresh.app, 0).title).toContain('Signal to partner — does not win the auction');

    // Only pre-winning-bid: a live contract kills indications for everyone.
    // Seat 1 opened the round, so the viewer (seat 0) is the dealer making
    // the last of the four calls; higher ladder bids stay open to them.
    const afterBid = renderAuction(
      runAuction(1, [bid(NUM, 7, 0), bid(PASS), bid(PASS)]),
    );
    for (let s = 0; s < 5; s++) expect(cell(afterBid.app, s).disabled).toBe(true);
    const raise = afterBid.app.container.querySelector(
      `button[data-bid="${bidKey(bid(NUM, 7, 2))}"]`,
    ) as HTMLButtonElement;
    expect(raise.disabled).toBe(false);
  });

  it('shows each seat its call as a chip: indications distinct, passes muted (AC-2)', () => {
    // One call per seat (single round): three calls in, dealer still to act.
    const state = runAuction(1, [bid(IND, 6, 3), bid(NUM, 7, 0), bid(PASS)]);
    const { app } = renderAuction(state);

    expect(chipTexts(chipsFor(app, 0))).toEqual([]); // dealer has not called yet
    expect(chipTexts(chipsFor(app, 1))).toEqual(['6♥ ind']);
    expect(chipTexts(chipsFor(app, 2))).toEqual(['7♠']);
    expect(chipTexts(chipsFor(app, 3))).toEqual(['Pass']);

    // Indications distinct, passes muted, a seat's (only) call emphasized.
    const indChip = chipsFor(app, 1)?.querySelector('.bid-chip');
    expect(indChip?.classList.contains('bid-chip-ind')).toBe(true);
    const bidChip = chipsFor(app, 2)?.querySelector('.bid-chip');
    expect(bidChip?.classList.contains('bid-chip-latest')).toBe(true);
    const pass = chipsFor(app, 3)?.querySelector('.bid-chip');
    expect(pass?.classList.contains('bid-chip-pass')).toBe(true);
  });

  it('toasts a redeal naming the new dealer, clears history, and auto-dismisses (AC-3)', () => {
    vi.useFakeTimers();
    // Mid-auction with visible history…
    const before = runAuction(0, [bid(IND, 6, 0), bid(PASS)]);
    const { client, app } = renderAuction(before);
    expect(chipTexts(chipsFor(app, 0))).not.toEqual([]);
    expect(app.queryByTestId('redeal-toast')).toBeNull();

    // …then the auction dies server-side: a fresh view arrives with the
    // redeals counter bumped, the dealer rotated, and an empty auction log.
    applyEvent(
      client,
      env(3, {
        t: 'gameView',
        view: {
          view: redactedViewFixture(0, {
            phase: 'auction',
            toAct: 1,
            auction: initAuction(1),
            redeals: 1,
            dealer: 0,
          }),
        },
      }),
    );
    const toast = app.getByTestId('redeal-toast');
    expect(toast.textContent).toBe('No winning bid — redealing. Ana deals.');
    // The fixed-size strips stay mounted (badge-size reserve, fh-8sw) but
    // every seat's chips are gone.
    for (let seat = 0; seat < 4; seat++) expect(chipTexts(chipsFor(app, seat))).toEqual([]);

    // A second redeal replaces the toast (never queues a stack)…
    applyEvent(
      client,
      env(4, {
        t: 'gameView',
        view: {
          view: redactedViewFixture(0, {
            phase: 'auction',
            toAct: 2,
            auction: initAuction(2),
            redeals: 2,
            dealer: 1,
          }),
        },
      }),
    );
    const replaced = app.getAllByTestId('redeal-toast');
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.textContent).toBe('No winning bid — redealing. Ben deals.');

    // …and the toast dismisses itself.
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(app.queryByTestId('redeal-toast')).toBeNull();
  });
});
