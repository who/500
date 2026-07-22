/**
 * M1 exit gate — the consolidated PRD section 7.1 rules suite.
 *
 * Part 1 ports every assertion from the Python oracle's _self_test
 * (five_hundred.py 652-673) verbatim. Part 2 adds one descriptively named
 * test per enumerated section 7.1 bullet, exercised through the public
 * package API (GameState actions and the exported pure functions) so the
 * suite doubles as API documentation and survives internal refactors.
 */

import { describe, expect, it } from 'vitest';
import {
  Action,
  Bid,
  DNULLA,
  GameState,
  IND,
  JOKER,
  LADDER,
  NT,
  NULLA,
  NUM,
  PASS,
  applyAction,
  applyHandResult,
  bid,
  bidName,
  bidValue,
  cardPower,
  effectiveSuit,
  initPlay,
  ladderIndex,
  legalPlays,
  legalPlaysFor,
  makeCard,
  newGame,
  partnerOf,
  playCard,
  scoreHand,
  toActSeat,
} from '../src/index.js';

// Suit indices in ladder order, matching the oracle's H, D, S, C = 3, 2, 0, 1.
const S = 0;
const C = 1;
const D = 2;
const H = 3;

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

function step(state: GameState, action: Action): GameState {
  const result = applyAction(state, action);
  if (!result.ok) {
    throw new Error(`${action.type} by seat ${action.seat} rejected: ${result.error.message}`);
  }
  return result.state;
}

/** Apply bids in turn order starting from whoever holds the auction turn. */
function auctionSteps(state: GameState, bids: readonly Bid[]): GameState {
  for (const b of bids) {
    const seat = toActSeat(state);
    if (seat === null) throw new Error('auction has no seat to act');
    state = step(state, { type: 'bid', seat, bid: b });
  }
  return state;
}

const pass = bid(PASS);

// ---------------------------------------------------------------------------
// Part 1 — _self_test port (five_hundred.py 652-673), assertion for assertion.
// ---------------------------------------------------------------------------

describe('_self_test port (five_hundred.py 652-673)', () => {
  it('bower ordering with hearts trump: joker > JH > JD > AH', () => {
    expect(cardPower(JOKER, H, S)).toBeGreaterThan(cardPower(makeCard(H, 11), H, S));
    expect(cardPower(makeCard(H, 11), H, S)).toBeGreaterThan(cardPower(makeCard(D, 11), H, S));
    expect(cardPower(makeCard(D, 11), H, S)).toBeGreaterThan(cardPower(makeCard(H, 14), H, S));
  });

  it('left bower follows trump, not its printed suit', () => {
    expect(effectiveSuit(makeCard(D, 11), H, D)).toBe(H);
  });

  it('ladder placement: nulla directly above 7NT; dnulla between 10D and 10H; 10NT highest', () => {
    const idx = (b: Bid) => ladderIndex(b) as number;
    expect(idx(bid(NULLA))).toBe(idx(bid(NUM, 7, NT)) + 1);
    expect(idx(bid(NULLA))).toBeLessThan(idx(bid(NUM, 8, S)));
    expect(idx(bid(NUM, 10, D))).toBeLessThan(idx(bid(DNULLA)));
    expect(idx(bid(DNULLA))).toBeLessThan(idx(bid(NUM, 10, H)));
    expect(idx(bid(NUM, 10, H))).toBeLessThan(idx(bid(NUM, 10, NT)));
  });

  it('Avondale spot checks: 7S = 140 and 10NT = 520', () => {
    expect(bidValue(bid(NUM, 7, S))).toBe(140);
    expect(bidValue(bid(NUM, 10, NT))).toBe(520);
  });

  it('joker blocks sluffing in NT: void in spades but holding the joker must play it', () => {
    const hand = [JOKER, makeCard(C, 9)];
    expect(legalPlays(hand, null, S)).toEqual([JOKER]);
  });

  it('in a trump hand the joker is a trump, so a spade lead can be sluffed', () => {
    const hand = [JOKER, makeCard(C, 9)];
    expect(new Set(legalPlays(hand, H, S))).toEqual(new Set(hand));
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the enumerated PRD section 7.1 cases, one test per bullet minimum.
// ---------------------------------------------------------------------------

describe('§7.1 ladder ordering (incl. nulla / double-nulla placements)', () => {
  it('the full 22-bid ladder runs 7S..7NT, NULLA, 8s, 9s, 10S..10D, DNULLA, 10H, 10NT', () => {
    expect(LADDER.map(bidName)).toEqual([
      '7S', '7C', '7D', '7H', '7NT',
      'NULLA',
      '8S', '8C', '8D', '8H', '8NT',
      '9S', '9C', '9D', '9H', '9NT',
      '10S', '10C', '10D',
      'DNULLA',
      '10H', '10NT',
    ]);
  });
});

describe('§7.1 Avondale values', () => {
  it('matches the full Avondale table plus nulla 250 and double nulla 500', () => {
    const table = [
      [140, 160, 180, 200, 220], // 7S 7C 7D 7H 7NT
      [240, 260, 280, 300, 320], // 8-level
      [340, 360, 380, 400, 420], // 9-level
      [440, 460, 480, 500, 520], // 10-level
    ];
    for (let level = 7; level <= 10; level++) {
      for (let strain = 0; strain <= 4; strain++) {
        expect(bidValue(bid(NUM, level, strain))).toBe(table[level - 7]![strain]);
      }
    }
    expect(bidValue(bid(NULLA))).toBe(250);
    expect(bidValue(bid(DNULLA))).toBe(500);
    expect(bidValue(bid(IND, 6, S))).toBe(0);
    expect(bidValue(pass)).toBe(0);
  });
});

describe('§7.1 bower following', () => {
  // Hearts trump. Seat 1's only heart-suit card is the left bower JD; the
  // right bower JH and the joker sit safely in the middle.
  const hands = [
    [makeCard(H, 13), ...range(0, 9)], // KH + 9 spades — leads trump
    [makeCard(D, 11), ...range(11, 9)], // JD (left bower) + 9 clubs
    [...range(22, 7), ...range(30, 3)], // diamonds only (JD excluded)
    [...range(33, 7), makeCard(H, 14), 9, 10], // low hearts + AH + 2 spades
  ];

  it('the left bower must follow a trump lead and beats the trump ace', () => {
    let play = initPlay(hands, bid(NUM, 8, H), 0, [0, 1, 2, 3]);
    play = playCard(play, 0, makeCard(H, 13)); // KH led: trump
    expect(legalPlaysFor(play, 1)).toEqual([makeCard(D, 11)]); // JD is the only trump held
    play = playCard(play, 1, makeCard(D, 11));
    play = playCard(play, 2, 22); // void in trump: sluffs
    play = playCard(play, 3, makeCard(H, 14)); // trump ace
    expect(play.tricks[0]!.winner).toBe(1); // left bower over AH and KH
    expect(play.leader).toBe(1);
  });
});

// NT layout: one suit per seat, seat 1 holding the joker instead of a club.
const NT_HANDS = [
  range(0, 10), // S4..SK
  [JOKER, ...range(11, 9)], // joker + 9 clubs
  range(22, 10), // diamonds
  range(33, 10), // hearts
];

describe('§7.1 joker blocks sluffing (through play)', () => {
  it('under NT a void seat holding the joker is forced to play it, and it wins the trick', () => {
    let play = initPlay(NT_HANDS, bid(NUM, 8, NT), 0, [0, 1, 2, 3]);
    play = playCard(play, 0, 0); // S4 led
    expect(legalPlaysFor(play, 1)).toEqual([JOKER]); // no spades, so the joker must follow
    play = playCard(play, 1, JOKER);
    play = playCard(play, 2, 22);
    play = playCard(play, 3, 33);
    expect(play.tricks[0]!.winner).toBe(1);
  });
});

describe('§7.1 joker silent suit assumption', () => {
  it('a joker played to a led trick silently assumes the led suit and refuses a named suit', () => {
    let play = initPlay(NT_HANDS, bid(NUM, 8, NT), 0, [0, 1, 2, 3]);
    play = playCard(play, 0, 0); // spades led
    expect(() => playCard(play, 1, JOKER, D)).toThrow(/only allowed when leading/);
    play = playCard(play, 1, JOKER); // no suit named: assumes spades
    expect(play.tricks.length === 0 ? play.ledSuit : play.tricks[0]!.ledSuit).toBe(S);
  });

  it('leading the joker with no trump requires naming a suit, which the trick then follows', () => {
    let play = initPlay(NT_HANDS, bid(NUM, 8, NT), 1, [0, 1, 2, 3]);
    expect(() => playCard(play, 1, JOKER)).toThrow(/requires jokerSuit/);
    play = playCard(play, 1, JOKER, H);
    expect(play.ledSuit).toBe(H);
    play = playCard(play, 2, 22); // void in hearts: sluffs
    expect(legalPlaysFor(play, 3)).toEqual(range(33, 10)); // hearts must follow
    play = playCard(play, 3, 33);
    play = playCard(play, 0, 0);
    expect(play.tricks[0]!.winner).toBe(1); // the joker takes the trick it led
  });
});

describe('§7.1 auction endings (single round of four calls)', () => {
  it('a winning bid followed by three passes ends the auction with that declarer', () => {
    const state = auctionSteps(newGame(1), [bid(NUM, 7, S), pass, pass, pass]);
    expect(state.phase).toBe('slamDecision'); // NUM contract: exchange opens on the slam offer
    expect(state.declarer).toBe(0);
    expect(state.contract).toEqual(bid(NUM, 7, S));
  });

  it('three calls leave the auction open for the dealer, the last caller', () => {
    const state = auctionSteps(newGame(1), [bid(NUM, 7, S), pass, pass]);
    expect(state.phase).toBe('auction');
    expect(state.auction?.done).toBe(false);
    expect(toActSeat(state)).toBe(3);
  });

  it("a dealer's fourth-call indication ends a winnerless auction as a redeal", () => {
    const start = newGame(5);
    const state = auctionSteps(start, [pass, pass, pass, bid(IND, 6, D)]);
    expect(state.phase).toBe('auction'); // auto-redealt into a fresh auction
    expect(state.dealsDrawn).toBe(2); // a second deal was consumed
    expect(state.auction?.indications).toHaveLength(0); // fresh log
    expect(state.dealer).toBe((start.dealer + 1) % 4);
  });
});

describe('§7.1 redeal', () => {
  it('four opening passes force an automatic redeal with fresh hands and a rotated dealer', () => {
    const start = newGame(11);
    const state = auctionSteps(start, [pass, pass, pass, pass]);
    expect(state.phase).toBe('auction');
    expect(state.dealsDrawn).toBe(2); // a second deal was consumed
    expect(state.handNumber).toBe(0); // but the hand number did not advance
    expect(state.dealer).toBe((start.dealer + 1) % 4);
    expect(state.auction?.indications).toEqual([]); // a fresh auction
    expect(JSON.stringify(state.hands)).not.toBe(JSON.stringify(start.hands));
    expect(state.game.scores).toEqual([0, 0]);
  });
});

describe('§7.1 double-nulla pass-through exchange', () => {
  it('the declarer keeps 10 of 15 and the exact 5 discards travel to the partner, all seats active', () => {
    let state = auctionSteps(newGame(7), [bid(DNULLA), pass, pass, pass]);
    expect(state.phase).toBe('middleExchange'); // no slam offer on a lose-all contract
    expect(state.declarer).toBe(0);
    expect(state.hands[0]).toHaveLength(15); // middle picked up

    const declarerHeld = [...state.hands[0]!];
    const keeps = declarerHeld.slice(0, 10);
    const passedOn = declarerHeld.slice(10);
    state = step(state, { type: 'discardKeeps', seat: 0, keeps });

    const partner = partnerOf(0);
    expect(state.phase).toBe('middleExchange'); // now the partner's discard
    expect(toActSeat(state)).toBe(partner);
    expect(state.hands[partner]).toHaveLength(15); // 10 + the 5 passed discards
    for (const c of passedOn) expect(state.hands[partner]).toContain(c);

    state = step(state, { type: 'discardKeeps', seat: partner, keeps: state.hands[partner]!.slice(0, 10) });
    expect(state.phase).toBe('play');
    expect(state.activeSeats).toEqual([0, 1, 2, 3]); // nobody sits out a double nulla
    for (const s of [0, 1, 2, 3]) expect(state.hands[s]).toHaveLength(10);
    expect(state.discards).toHaveLength(5);
  });
});

describe('§7.1 slam 16-to-10 flow', () => {
  it('partner surrenders a card, the declarer keeps 10 of 16, and the partner sits out', () => {
    let state = auctionSteps(newGame(9), [bid(NUM, 8, C), pass, pass, pass]);
    expect(state.phase).toBe('slamDecision');
    expect(state.hands[0]).toHaveLength(15); // middle already picked up

    state = step(state, { type: 'declareSlam', seat: 0 });
    const partner = partnerOf(0);
    expect(state.phase).toBe('partnerCard');
    expect(toActSeat(state)).toBe(partner);

    state = step(state, { type: 'giveCard', seat: partner, card: state.hands[partner]![0]! });
    expect(state.phase).toBe('middleExchange');
    expect(state.hands[0]).toHaveLength(16); // 15 + the surrendered card

    state = step(state, { type: 'discardKeeps', seat: 0, keeps: state.hands[0]!.slice(0, 10) });
    expect(state.phase).toBe('play');
    expect(state.slam).toBe(true);
    expect(state.activeSeats).toEqual([0, 1, 3]); // the partner sits the slam out
    expect(state.hands[partner]).toHaveLength(9); // untouched since giving the card
    expect(state.discards).toHaveLength(6); // 16 held minus 10 kept
  });
});

describe('§7.1 scoring for every contract class (incl. defender points on lose-all)', () => {
  it('NUM: made at or above the level for +value, set for -value, defenders 10 per trick', () => {
    const made = scoreHand(bid(NUM, 8, H), 0, false, [8, 2]);
    expect(made.made).toBe(true);
    expect(made.declarerDelta).toBe(300);
    expect(made.defenderDelta).toBe(20);
    const set = scoreHand(bid(NUM, 8, H), 0, false, [7, 3]);
    expect(set.made).toBe(false);
    expect(set.declarerDelta).toBe(-300);
    expect(set.defenderDelta).toBe(30);
  });

  it('slam: +/-(value + 250), lost even when 9 tricks are taken', () => {
    const made = scoreHand(bid(NUM, 8, C), 1, true, [0, 10]);
    expect(made.made).toBe(true);
    expect(made.declarerDelta).toBe(260 + 250);
    const nine = scoreHand(bid(NUM, 8, C), 1, true, [1, 9]);
    expect(nine.made).toBe(false);
    expect(nine.declarerDelta).toBe(-(260 + 250));
    expect(nine.defenderDelta).toBe(10);
  });

  it('nulla: made only on zero declarer tricks; defenders score 10 per trick forced on the bidders', () => {
    const made = scoreHand(bid(NULLA), 0, false, [0, 10]);
    expect(made.made).toBe(true);
    expect(made.declarerDelta).toBe(250);
    expect(made.defenderDelta).toBe(0);
    const set = scoreHand(bid(NULLA), 0, false, [3, 7]);
    expect(set.made).toBe(false);
    expect(set.declarerDelta).toBe(-250);
    expect(set.defenderDelta).toBe(30); // 10 per trick FORCED ONTO the bidding side
  });

  it('double nulla: +/-500 with the same forced-trick defender points', () => {
    const made = scoreHand(bid(DNULLA), 2, false, [0, 10]);
    expect(made.made).toBe(true);
    expect(made.declarerDelta).toBe(500);
    const set = scoreHand(bid(DNULLA), 2, false, [1, 9]);
    expect(set.declarerDelta).toBe(-500);
    expect(set.defenderDelta).toBe(10);
  });
});

describe('§7.1 out the back', () => {
  it('a side at exactly -500 goes out the back and the opponents win', () => {
    const game = { scores: [-360, 0] as const, winner: null };
    const next = applyHandResult(game, scoreHand(bid(NUM, 7, S), 0, false, [6, 4]));
    expect(next.scores[0]).toBe(-500);
    expect(next.winner).toBe(1);
  });

  it('defenders going out the back hand the declarer side the game', () => {
    const game = { scores: [100, -480] as const, winner: null };
    // Defenders take 0 tricks but a prior penalty already has them at -480;
    // a further failed nulla by side 1 drops them out the back.
    const next = applyHandResult(game, scoreHand(bid(NULLA), 1, false, [4, 6]));
    expect(next.scores[1]).toBe(-730);
    expect(next.winner).toBe(0);
  });
});

describe('§7.1 both sides cross 500 in one hand', () => {
  it('resolves for the declarer side even when the defenders also cross', () => {
    const game = { scores: [480, 490] as const, winner: null };
    const result = scoreHand(bid(NUM, 7, S), 0, false, [8, 2]);
    const next = applyHandResult(game, result);
    expect(next.scores).toEqual([620, 510]); // both sides over 500
    expect(next.winner).toBe(0); // declarer side checked first
  });

  it('a side can win on defender points alone', () => {
    const game = { scores: [100, 490] as const, winner: null };
    const next = applyHandResult(game, scoreHand(bid(NUM, 8, S), 0, false, [8, 2]));
    expect(next.scores[1]).toBe(510);
    expect(next.winner).toBe(1);
  });
});
