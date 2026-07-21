import { describe, expect, it } from 'vitest';
import {
  AuctionState,
  DNULLA,
  IND,
  LADDER,
  NULLA,
  NUM,
  PASS,
  applyAuctionAction,
  auctionResult,
  bid,
  initAuction,
  ladderIndex,
  legalBids,
} from '../src/index.js';

/** Feed actions in turn order starting from the state's current turn. */
function play(state: AuctionState, ...actions: Parameters<typeof bid>[]): AuctionState {
  for (const [kind, level, strain] of actions) {
    state = applyAuctionAction(state, state.turn, bid(kind, level, strain));
  }
  return state;
}

const PASS_BID = [PASS] as Parameters<typeof bid>;

describe('auction termination', () => {
  it('yields the contract after a bid and three passes (AC-1)', () => {
    const state = play(initAuction(0), [NUM, 7, 0], PASS_BID, PASS_BID, PASS_BID);
    expect(state.done).toBe(true);
    expect(auctionResult(state)).toEqual({
      contract: bid(NUM, 7, 0),
      declarer: 0,
      indications: [],
    });
  });

  it('yields a redeal after four passes from the start (AC-1)', () => {
    const state = play(initAuction(1), PASS_BID, PASS_BID, PASS_BID, PASS_BID);
    expect(state.done).toBe(true);
    expect(auctionResult(state)).toEqual({ contract: null, declarer: null, indications: [] });
  });

  it('does not end on only two passes after a winning bid', () => {
    const state = play(initAuction(0), [NUM, 7, 0], PASS_BID, PASS_BID);
    expect(state.done).toBe(false);
    expect(auctionResult(state)).toBeNull();
  });

  it('lets a later higher bid overtake the declarer', () => {
    const state = play(
      initAuction(0),
      [NUM, 7, 0], // seat 0 bids 7S
      [NUM, 8, 2], // seat 1 overtakes with 8D
      PASS_BID,
      PASS_BID,
      PASS_BID,
    );
    expect(auctionResult(state)).toEqual({
      contract: bid(NUM, 8, 2),
      declarer: 1,
      indications: [],
    });
  });

  it('ranks NULLA and DNULLA on the ladder like the oracle', () => {
    const state = play(initAuction(0), [NULLA], [DNULLA], PASS_BID, PASS_BID, PASS_BID);
    expect(auctionResult(state)).toEqual({
      contract: bid(DNULLA),
      declarer: 1,
      indications: [],
    });
  });
});

describe('indications', () => {
  it('yields a redeal from an indications-only auction (AC-2)', () => {
    let state = initAuction(0);
    for (let s = 0; s < 4; s++) state = play(state, [IND, 6, s]);
    expect(state.done).toBe(false); // each indication reset the quiet count
    state = play(state, PASS_BID, PASS_BID, PASS_BID, PASS_BID);
    expect(auctionResult(state)).toEqual({
      contract: null,
      declarer: null,
      indications: [0, 1, 2, 3].map((s) => ({ seat: s, bid: bid(IND, 6, s) })),
    });
  });

  it('keeps the auction alive when an indication follows three passes', () => {
    const state = play(initAuction(0), PASS_BID, PASS_BID, PASS_BID, [IND, 6, 4]);
    expect(state.done).toBe(false);
    expect(state.consecutiveQuiet).toBe(0);
  });

  it('counts a second indication by the same player as a pass (AC-2)', () => {
    let state = play(initAuction(0), [IND, 6, 0], PASS_BID, PASS_BID, PASS_BID);
    expect(state.done).toBe(false); // 3 quiet, no declarer
    state = play(state, [IND, 6, 1]); // seat 0 again: counts as the 4th pass
    expect(auctionResult(state)).toEqual({
      contract: null,
      declarer: null,
      indications: [{ seat: 0, bid: bid(IND, 6, 0) }],
    });
  });

  it('counts an indication after a winning bid as a pass', () => {
    const state = play(initAuction(0), [NUM, 7, 0], [IND, 6, 1], [IND, 6, 2], [IND, 6, 3]);
    expect(auctionResult(state)).toEqual({
      contract: bid(NUM, 7, 0),
      declarer: 0,
      indications: [],
    });
  });

  it('lets a player indicate and later win the auction', () => {
    const state = play(
      initAuction(0),
      [IND, 6, 3], // seat 0 indicates hearts
      PASS_BID,
      PASS_BID,
      PASS_BID,
      [NUM, 8, 3], // seat 0 then bids 8H
      PASS_BID,
      PASS_BID,
      PASS_BID,
    );
    expect(auctionResult(state)).toEqual({
      contract: bid(NUM, 8, 3),
      declarer: 0,
      indications: [{ seat: 0, bid: bid(IND, 6, 3) }],
    });
  });
});

describe('legalBids', () => {
  it('offers only strictly-higher ladder bids (AC-3)', () => {
    const state = play(initAuction(0), [NUM, 8, 2]); // 8D
    const legal = legalBids(state, 1);
    const floor = ladderIndex(bid(NUM, 8, 2)) as number;
    const ladderBids = legal.filter((b) => ladderIndex(b) !== undefined);
    expect(ladderBids.length).toBeGreaterThan(0);
    for (const b of ladderBids) expect(ladderIndex(b)).toBeGreaterThan(floor);
  });

  it('offers IND only while no declarer exists and the seat has not indicated (AC-3)', () => {
    const fresh = initAuction(0);
    expect(legalBids(fresh, 0).filter((b) => b.kind === IND)).toHaveLength(5);

    const afterOwnInd = play(fresh, [IND, 6, 0], PASS_BID, PASS_BID, PASS_BID);
    expect(afterOwnInd.turn).toBe(0);
    expect(legalBids(afterOwnInd, 0).some((b) => b.kind === IND)).toBe(false);

    const afterBid = play(initAuction(0), [NUM, 7, 0]);
    expect(legalBids(afterBid, 1).some((b) => b.kind === IND)).toBe(false);
  });

  it('offers only PASS at the top of the ladder without indication rights', () => {
    const state = play(initAuction(0), [NUM, 10, 4]); // 10NT, the highest bid
    expect(legalBids(state, 1)).toEqual([bid(PASS)]);
  });

  it('returns nothing out of turn or once the auction is over', () => {
    const running = initAuction(0);
    expect(legalBids(running, 2)).toEqual([]);
    const finished = play(running, PASS_BID, PASS_BID, PASS_BID, PASS_BID);
    expect(legalBids(finished, finished.turn)).toEqual([]);
  });

  it('always includes every remaining ladder bid plus PASS', () => {
    const state = initAuction(0);
    expect(legalBids(state, 0)).toHaveLength(LADDER.length + 5 + 1);
  });
});

describe('auction history log', () => {
  it('records every applied action in table order, indications and passes included', () => {
    const state = play(initAuction(1), [IND, 6, 2], PASS_BID, [NUM, 7, 0], [NUM, 8, 4]);
    expect(state.history).toEqual([
      { seat: 1, bid: bid(IND, 6, 2) },
      { seat: 2, bid: bid(PASS) },
      { seat: 3, bid: bid(NUM, 7, 0) },
      { seat: 0, bid: bid(NUM, 8, 4) },
    ]);
    // A fresh auction (redeal path) starts with an empty log.
    expect(initAuction(2).history).toEqual([]);
  });
});

describe('reducer mechanics', () => {
  it('does not mutate the input state', () => {
    const before = initAuction(0);
    const frozen = JSON.stringify(before);
    applyAuctionAction(before, 0, bid(NUM, 7, 0));
    expect(JSON.stringify(before)).toBe(frozen);
  });

  it('advances the turn (seat+1)%4 and rejects out-of-turn actions', () => {
    const state = play(initAuction(3), PASS_BID);
    expect(state.turn).toBe(0);
    expect(() => applyAuctionAction(state, 2, bid(PASS))).toThrow(/turn/);
  });

  it('treats a too-low bid as a pass (parity replay tolerance)', () => {
    const state = play(initAuction(0), [NUM, 8, 0], [NUM, 7, 0], PASS_BID, PASS_BID);
    expect(auctionResult(state)).toEqual({
      contract: bid(NUM, 8, 0),
      declarer: 0,
      indications: [],
    });
  });

  it('round-trips through JSON (protocol-plain state)', () => {
    const state = play(initAuction(0), [IND, 6, 1], [NUM, 7, 2]);
    const revived = JSON.parse(JSON.stringify(state)) as AuctionState;
    expect(revived).toEqual(state);
    expect(legalBids(revived, revived.turn)).toEqual(legalBids(state, state.turn));
  });
});
