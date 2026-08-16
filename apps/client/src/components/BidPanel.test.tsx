// @vitest-environment jsdom

import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Action,
  type AuctionState,
  type Bid,
  DNULLA,
  IND,
  LADDER,
  NT,
  NULLA,
  NUM,
  PASS,
  bid,
  bidKey,
  ladderIndex,
  legalBids,
} from '@five-hundred/engine';
import type { ClientCommand } from '@five-hundred/protocol';
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
  type TestClient,
} from '../screens/test-helpers.tsx';

beforeEach(() => {
  installFakeLocalStorage();
  history.replaceState(null, '', '/');
  // Existing panel specs assert the auction UI, not the deal flights.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
    onchange: null,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
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

/** Live auction with the ladder at `ladderPos` (-1 = no winning bid yet). */
function auctionAt(ladderPos: number, turn: number, overrides: Partial<AuctionState> = {}): AuctionState {
  return {
    ladderPos,
    declarer: ladderPos >= 0 ? (turn + 1) % 4 : null,
    indications: [],
    indicated: [false, false, false, false],
    history: [],
    turn,
    done: false,
    ...overrides,
  };
}

/** The actionRequest payload the server would send: engine legalBids verbatim. */
function bidActions(state: AuctionState, seat: number): Action[] {
  return legalBids(state, seat).map((b): Action => ({ type: 'bid', seat, bid: b }));
}

function renderAuction(state: AuctionState, viewerSeat = 0) {
  const client = makeClient();
  const app = renderApp(client);
  applyEvent(client, env(0, { t: 'roomState', room: ROOM }));
  applyEvent(
    client,
    env(1, {
      t: 'gameView',
      view: {
        view: redactedViewFixture(viewerSeat, {
          phase: 'auction',
          toAct: state.turn,
          auction: state,
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

function panelButtons(app: ReturnType<typeof renderApp>): HTMLButtonElement[] {
  return [...app.getByTestId('bid-panel').querySelectorAll('button[data-bid]')] as HTMLButtonElement[];
}

function cellFor(app: ReturnType<typeof renderApp>, b: Bid): HTMLButtonElement {
  const el = app.getByTestId('bid-panel').querySelector(`button[data-bid="${bidKey(b)}"]`);
  expect(el).not.toBeNull();
  return el as HTMLButtonElement;
}

function enabledKeys(app: ReturnType<typeof renderApp>): Set<string> {
  return new Set(
    panelButtons(app)
      .filter((b) => !b.disabled)
      .map((b) => b.getAttribute('data-bid') as string),
  );
}

function sentBids(client: TestClient): ClientCommand[] {
  return client.sent.filter((c) => c.t === 'bid');
}

describe('BidPanel', () => {
  it('enables exactly the server-sent legal bids, each with its avondale value (AC-1)', () => {
    // 8♥ has been bid; the viewer holds the turn. Legal: everything above
    // 8H on the ladder except double nulla (the viewer's partner has not bid
    // nulla, fh-17b), plus Pass — and no indications, since a winning bid
    // exists (the engine stops offering IND, so the cells stay disabled).
    const at8H = ladderIndex(bid(NUM, 8, 3)) as number;
    const { app } = renderAuction(auctionAt(at8H, 0));

    const expected = new Set([
      ...LADDER.slice(at8H + 1)
        .filter((b) => b.kind !== 'DNULLA')
        .map(bidKey),
      bidKey(bid(PASS)),
    ]);
    expect(enabledKeys(app)).toEqual(expected);

    // Outbid cells stay in the grid, disabled — spatial stability.
    expect(cellFor(app, bid(NUM, 7, 0)).disabled).toBe(true);
    expect(cellFor(app, bid(NUM, 8, 3)).disabled).toBe(true);
    expect(cellFor(app, bid(NULLA)).disabled).toBe(true);
    expect(cellFor(app, bid(DNULLA)).disabled).toBe(true);

    // Values from the avondale table on the cells themselves.
    expect(cellFor(app, bid(NUM, 8, NT)).textContent).toBe('8NT320');
    expect(cellFor(app, bid(NUM, 8, NT)).querySelector('.suit-glyph')).toBeNull();
    expect(cellFor(app, bid(NUM, 10, 3)).textContent).toBe('10♥500');
    expect(cellFor(app, bid(NUM, 10, 3)).querySelector('.suit-glyph.suit-red')?.textContent).toBe(
      '♥',
    );
    expect(app.getByTestId('bid-panel').querySelector('.bid-col-head .suit-glyph.suit-black')).not.toBeNull();
    expect(cellFor(app, bid(DNULLA)).textContent).toBe('Double Nulla500');
    expect(cellFor(app, bid(NULLA)).textContent).toBe('Nulla250');
    expect(cellFor(app, bid(PASS)).textContent).toBe('Pass');

    // Every indication cell renders but stays disabled post-winning-bid.
    for (let s = 0; s < 5; s++) {
      expect(cellFor(app, bid(IND, 6, s)).disabled).toBe(true);
    }

    // The panel replaces the trick area during the auction.
    expect(app.queryByTestId('trick-area')).toBeNull();
  });

  it('enables the double nulla cell once the partner has bid nulla (fh-17b)', () => {
    // Same 8♥ position, but the viewer's partner opened the auction with
    // NULLA, so the engine now offers the double and the cell unlocks.
    const at8H = ladderIndex(bid(NUM, 8, 3)) as number;
    const { app } = renderAuction(
      auctionAt(at8H, 0, { history: [{ seat: 2, bid: bid(NULLA) }] }),
    );
    expect(cellFor(app, bid(DNULLA)).disabled).toBe(false);
  });

  it('offers only 10♥, 10NT, and Pass once double nulla is bid (ladder-top edge)', () => {
    const atDN = ladderIndex(bid(DNULLA)) as number;
    const { app } = renderAuction(auctionAt(atDN, 0));
    expect(enabledKeys(app)).toEqual(
      new Set([bidKey(bid(NUM, 10, 3)), bidKey(bid(NUM, 10, NT)), bidKey(bid(PASS))]),
    );
  });

  it('emits the bid command once and locks until the next view (AC-2)', () => {
    const at8H = ladderIndex(bid(NUM, 8, 3)) as number;
    const { client, app } = renderAuction(auctionAt(at8H, 0));

    fireEvent.click(cellFor(app, bid(NUM, 8, NT)));
    expect(sentBids(client)).toEqual([{ t: 'bid', bid: bid(NUM, 8, NT) }]);

    // Locked: repeat clicks and other cells are inert until the next view.
    fireEvent.click(cellFor(app, bid(NUM, 8, NT)));
    fireEvent.click(cellFor(app, bid(NUM, 10, NT)));
    fireEvent.click(cellFor(app, bid(PASS)));
    expect(sentBids(client)).toHaveLength(1);

    // A server rejection surfaces and unlocks for a retry.
    applyEvent(client, {
      event: { t: 'error', code: 'illegalAction', message: '8NT is not a legal bid for seat 0' },
    });
    expect(app.getByTestId('bid-error').textContent).toBe('8NT is not a legal bid for seat 0');
    fireEvent.click(cellFor(app, bid(NUM, 10, NT)));
    expect(sentBids(client)).toHaveLength(2);

    // The next view (turn moved on) leaves the panel visible but passive.
    applyEvent(
      client,
      env(3, {
        t: 'gameView',
        view: {
          view: redactedViewFixture(0, {
            phase: 'auction',
            toAct: 1,
            auction: auctionAt(ladderIndex(bid(NUM, 10, NT)) as number, 1),
          }),
        },
      }),
    );
    expect(app.getByTestId('bid-panel')).toBeDefined();
    expect(enabledKeys(app).size).toBe(0);
  });

  it('enables indication cells exactly while the server offers them, and submits one', () => {
    // Fresh auction, no winning bid, viewer has not indicated: the engine's
    // legal set carries all 5 IND bids, so every indication cell enables.
    const { client, app } = renderAuction(auctionAt(-1, 0));
    const expected = new Set([
      ...LADDER.filter((b) => b.kind !== 'DNULLA').map(bidKey),
      ...[0, 1, 2, 3, NT].map((s) => bidKey(bid(IND, 6, s))),
      bidKey(bid(PASS)),
    ]);
    expect(enabledKeys(app)).toEqual(expected);

    // Each indication cell carries the explanatory tooltip.
    expect(cellFor(app, bid(IND, 6, 3)).title).toBe(
      '6H (indication): Signal to partner — does not win the auction',
    );

    fireEvent.click(cellFor(app, bid(IND, 6, 3)));
    expect(sentBids(client)).toEqual([{ t: 'bid', bid: bid(IND, 6, 3) }]);
  });

  it('disables indication once the seat has indicated (legal set drives it)', () => {
    // Ladder untouched, but the viewer already indicated: the engine stops
    // offering IND to them while every ladder bid stays available.
    const { app } = renderAuction(auctionAt(-1, 0, { indicated: [true, false, false, false] }));
    for (let s = 0; s < 5; s++) {
      expect(cellFor(app, bid(IND, 6, s)).disabled).toBe(true);
    }
    expect(cellFor(app, bid(NUM, 7, 0)).disabled).toBe(false);
    expect(cellFor(app, bid(PASS)).disabled).toBe(false);
  });

  it('tap-toggles the indication tooltip for touch devices', () => {
    const { app } = renderAuction(auctionAt(-1, 0));
    expect(app.queryByTestId('ind-tooltip')).toBeNull();
    const info = app.getByLabelText('What is an indication?');
    fireEvent.click(info);
    expect(app.getByTestId('ind-tooltip').textContent).toBe(
      'Signal to partner — does not win the auction',
    );
    fireEvent.click(info);
    expect(app.queryByTestId('ind-tooltip')).toBeNull();
  });

  it("labels the dealer's pass 'Redeal' while no winning bid exists (fh-8i7 AC-4)", () => {
    // The fixture's dealer is seat 3. Three passes in, no winning bid, the
    // dealer holds the last call: their pass IS the throw-in choice.
    const deadAtDealer = auctionAt(-1, 3, {
      history: [0, 1, 2].map((s) => ({ seat: s, bid: bid(PASS) })),
    });
    const { client, app } = renderAuction(deadAtDealer, 3);
    const passCell = cellFor(app, bid(PASS));
    expect(passCell.textContent).toBe('Redeal');
    expect(passCell.title).toBe('No winning bid — passing throws the hand in for a redeal');
    fireEvent.click(passCell);
    expect(sentBids(client)).toEqual([{ t: 'bid', bid: bid(PASS) }]);
  });

  it("keeps the dealer's pass an ordinary 'Pass' once a winning bid exists", () => {
    const contested = auctionAt(ladderIndex(bid(NUM, 7, 0)) as number, 3);
    expect(cellFor(renderAuction(contested, 3).app, bid(PASS)).textContent).toBe('Pass');
  });

  it("never shows a non-dealer seat the redeal label, even with no bid yet", () => {
    expect(cellFor(renderAuction(auctionAt(-1, 0), 0).app, bid(PASS)).textContent).toBe('Pass');
  });

  it('shows off-turn seats a fully disabled panel (AC-3)', () => {
    // Ben (seat 1) holds the bid turn; the viewer (Ana, seat 0) spectates.
    const { client, app } = renderAuction(auctionAt(-1, 1), 0);
    expect(app.getByTestId('bid-panel').dataset.active).toBeUndefined();
    expect(panelButtons(app).length).toBeGreaterThan(20);
    for (const button of panelButtons(app)) expect(button.disabled).toBe(true);

    // Clicking anyway sends nothing.
    fireEvent.click(cellFor(app, bid(NUM, 7, 0)));
    fireEvent.click(cellFor(app, bid(PASS)));
    expect(sentBids(client)).toHaveLength(0);
  });
});
