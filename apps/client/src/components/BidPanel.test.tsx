// @vitest-environment jsdom

import { fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Action,
  type AuctionState,
  type Bid,
  DNULLA,
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
function auctionAt(ladderPos: number, turn: number): AuctionState {
  return {
    ladderPos,
    declarer: ladderPos >= 0 ? (turn + 1) % 4 : null,
    indications: [],
    indicated: [false, false, false, false],
    consecutiveQuiet: 0,
    turn,
    done: false,
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
    // 8H on the ladder, plus Pass. (The 5 IND actions the server also sends
    // have no active cell in this leaf — the slot stays disabled.)
    const at8H = ladderIndex(bid(NUM, 8, 3)) as number;
    const { app } = renderAuction(auctionAt(at8H, 0));

    const expected = new Set([...LADDER.slice(at8H + 1).map(bidKey), bidKey(bid(PASS))]);
    expect(enabledKeys(app)).toEqual(expected);

    // Outbid cells stay in the grid, disabled — spatial stability.
    expect(cellFor(app, bid(NUM, 7, 0)).disabled).toBe(true);
    expect(cellFor(app, bid(NUM, 8, 3)).disabled).toBe(true);
    expect(cellFor(app, bid(NULLA)).disabled).toBe(true);
    expect(cellFor(app, bid(DNULLA)).disabled).toBe(false);

    // Values from the avondale table on the cells themselves.
    expect(cellFor(app, bid(NUM, 8, NT)).textContent).toBe('8NT320');
    expect(cellFor(app, bid(NUM, 10, 3)).textContent).toBe('10♥500');
    expect(cellFor(app, bid(DNULLA)).textContent).toBe('Double Nulla500');
    expect(cellFor(app, bid(NULLA)).textContent).toBe('Nulla250');
    expect(cellFor(app, bid(PASS)).textContent).toBe('Pass');

    // The indication slot exists but is inert until the M6 leaf.
    const ind = app.getByTestId('bid-panel').querySelector('[data-bid="IND"]');
    expect((ind as HTMLButtonElement).disabled).toBe(true);

    // The panel replaces the trick area during the auction.
    expect(app.queryByTestId('trick-area')).toBeNull();
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
