/**
 * The shared "bidders are set" predicate (fh-d2d AC-5), at the boundaries:
 * exactly-can-still-make vs just-set, for numbered contracts, slams and the
 * lose-all bids, plus the hand-end result fallback.
 */

import { describe, expect, it } from 'vitest';
import { type HandResult, DNULLA, NULLA, NUM, bid } from '@five-hundred/engine';
import { biddersAreSet, type SetStateView } from './biddersSet.ts';

/** Mid-play state: 8H by seat 1, no scored result yet. */
function view(overrides: Partial<SetStateView> = {}): SetStateView {
  return {
    contract: bid(NUM, 8, 3),
    declarer: 1,
    slam: false,
    sideTricks: [0, 0],
    handResult: null,
    ...overrides,
  };
}

function result(made: boolean): HandResult {
  return {
    contract: bid(NUM, 8, 3),
    declarer: 1,
    slam: false,
    made,
    declarerDelta: made ? 220 : -220,
    defenderDelta: 0,
    declarerSideTricks: made ? 8 : 2,
    defenderSideTricks: made ? 2 : 8,
  };
}

describe('numbered contracts', () => {
  it('is not set while the bidders can still reach the level', () => {
    // 8H: two defender tricks leave a ceiling of 8 — exactly enough.
    expect(biddersAreSet(view({ sideTricks: [2, 0] }))).toBe(false);
  });

  it('is set the moment the ceiling drops below the level', () => {
    // The third defender trick caps the bidders at 7 against a bid of 8.
    expect(biddersAreSet(view({ sideTricks: [3, 0] }))).toBe(true);
  });

  it('counts the defenders as the side opposite the declarer', () => {
    // Same three tricks, but now on the declaring side: nothing is decided.
    expect(biddersAreSet(view({ sideTricks: [0, 3] }))).toBe(false);
    // Declarer at seat 0 flips which index is the defenders'.
    expect(biddersAreSet(view({ declarer: 0, sideTricks: [0, 3] }))).toBe(true);
  });

  it('sets a 10-level bid on the first defender trick', () => {
    expect(biddersAreSet(view({ contract: bid(NUM, 10, 4), sideTricks: [0, 0] }))).toBe(false);
    expect(biddersAreSet(view({ contract: bid(NUM, 10, 4), sideTricks: [1, 0] }))).toBe(true);
  });

  it('stays clear before a contract exists', () => {
    expect(biddersAreSet(view({ contract: null, declarer: null }))).toBe(false);
    expect(biddersAreSet(view({ declarer: null, sideTricks: [9, 0] }))).toBe(false);
  });
});

describe('slam', () => {
  it('is set by any defender trick, whatever the bid level', () => {
    expect(biddersAreSet(view({ slam: true, sideTricks: [0, 0] }))).toBe(false);
    expect(biddersAreSet(view({ slam: true, sideTricks: [1, 0] }))).toBe(true);
  });
});

describe('lose-all contracts', () => {
  it('is set the instant a nulla bidder is forced to take a trick', () => {
    const nulla = view({ contract: bid(NULLA), declarer: 0 });
    expect(biddersAreSet({ ...nulla, sideTricks: [0, 4] })).toBe(false);
    expect(biddersAreSet({ ...nulla, sideTricks: [1, 4] })).toBe(true);
  });

  it('treats double nulla the same way', () => {
    const dnulla = view({ contract: bid(DNULLA), declarer: 1 });
    expect(biddersAreSet({ ...dnulla, sideTricks: [5, 0] })).toBe(false);
    expect(biddersAreSet({ ...dnulla, sideTricks: [5, 1] })).toBe(true);
  });
});

describe('hand end', () => {
  it('takes the scored result as the answer once the hand is over', () => {
    // A make shows nothing; a hand that only failed on the final trick — the
    // case the mid-hand math cannot call early — shows the set state.
    expect(biddersAreSet(view({ sideTricks: [2, 8], handResult: result(true) }))).toBe(false);
    expect(biddersAreSet(view({ sideTricks: [3, 7], handResult: result(false) }))).toBe(true);
  });
});
