/**
 * Headless sim harness — TS port of the oracle's Monte Carlo tail
 * (five_hundred.py: simulate_hands 561-574, print_stats 577-582,
 * simulate_games 585-591, play_game 537-555, play_one_hand 520-531).
 *
 * Where the oracle re-implements deal/auction/play inline, this harness
 * drives full hands and games through the engine's public GameState API
 * (applyAction), promoting the GameState -> Policy driver that previously
 * lived in easy.spec.ts / medium.spec.ts to shared code. Everything here is
 * pure and synchronous — zero timers, zero I/O beyond printStats — so the
 * same driver runs in tests, the CLI, and later inside Hard-bot rollouts
 * and the server's pacing loop (PRD 4.4: pacing skipped in headless mode).
 * The one exception is simulateGamesYielding, which trades strict synchrony
 * for an event-loop yield per game so long runs don't starve vitest workers.
 *
 * Known divergences from the oracle, both resolved upstream in the engine:
 * a dead auction rotates the dealer instead of redealing to the same first
 * bidder (fh-qsk.7), and the mulberry32 rng replaces Python's Mersenne
 * Twister, so stats are comparable in shape, not stream-identical.
 */

import type { Action, Bid, Card, GameState, Rng } from '@five-hundred/engine';
import {
  JOKER,
  PASS,
  applyAction,
  bid,
  bidName,
  legalPlaysFor,
  makeRng,
  mayDoubleNulla,
  newGame,
  toActSeat,
} from '@five-hundred/engine';
import type { Policy } from './policy.js';
import { hasStatePlay } from './policy.js';

/** Oracle play_one_hand max_redeals: fail loudly if an auction never lands. */
export const MAX_REDEALS = 10_000;

/** Oracle play_game max_hands: most points wins if nobody reaches +500. */
export const MAX_GAME_HANDS = 300;

/**
 * Ask seat's policy for the next action, mirroring the oracle's play_hand /
 * run_auction call sites. handScored maps to nextHand (any seat may send it).
 */
export function botAction(state: GameState, policies: readonly Policy[], rng: Rng): Action {
  if (state.phase === 'handScored') return { type: 'nextHand', seat: 0 };
  const seat = toActSeat(state);
  if (seat === null) throw new Error(`no seat to act during ${state.phase}`);
  return policyAction(state, seat, policies[seat] as Policy, rng);
}

/**
 * One seat's decision as an engine action — the phase -> Policy-method map,
 * shared by botAction above, the server bot driver's worker pool, and any
 * other caller that resolves the acting seat itself. State-aware policies
 * (the Hard bot) get the full state for their play decision through the
 * StateAwarePolicy seam; everyone else gets the classic choosePlay view.
 */
export function policyAction(
  state: GameState,
  seat: number,
  policy: Policy,
  rng: Rng,
): Action {
  const contract = state.contract as Bid;
  const hand = state.hands[seat] ?? [];
  switch (state.phase) {
    case 'auction': {
      const auction = state.auction;
      if (auction === null) throw new Error('auction phase without auction state');
      const mayIndicate = auction.declarer === null && !auction.indicated[seat];
      return {
        type: 'bid',
        seat,
        bid: policy.chooseBid(
          hand,
          auction.ladderPos,
          mayIndicate,
          {
            seat,
            indications: auction.indications,
            scores: state.game.scores,
            mayDoubleNulla: mayDoubleNulla(auction, seat),
          },
          rng,
        ),
      };
    }
    case 'slamDecision':
      return policy.considerSlam(hand, contract, rng)
        ? { type: 'declareSlam', seat }
        : { type: 'declineSlam', seat };
    case 'partnerCard':
      return { type: 'giveCard', seat, card: policy.giveBestCard(hand, contract, rng) };
    case 'middleExchange':
      return { type: 'discardKeeps', seat, keeps: policy.chooseKeeps(hand, contract, rng) };
    case 'play': {
      const play = state.play;
      if (play === null) throw new Error('play phase without play state');
      if (hasStatePlay(policy)) {
        const { card, jokerSuit } = policy.choosePlayFromState(state, seat, rng);
        return jokerSuit === undefined
          ? { type: 'playCard', seat, card }
          : { type: 'playCard', seat, card, jokerSuit };
      }
      const legal = legalPlaysFor(play, seat);
      const card = policy.choosePlay(
        seat,
        play.hands[seat] ?? [],
        legal,
        play.plays,
        play.trump,
        play.ledSuit,
        contract,
        { declarer: play.declarer, tricks: play.tricks },
        rng,
      );
      if (card === JOKER && play.trump === null && play.ledSuit === null) {
        // The oracle names the suit from the hand with the joker removed
        // (five_hundred.py 483-485).
        const rest = (play.hands[seat] ?? []).filter((c: Card) => c !== JOKER);
        return {
          type: 'playCard',
          seat,
          card,
          jokerSuit: policy.chooseJokerSuit(rest, contract, rng),
        };
      }
      return { type: 'playCard', seat, card };
    }
    default:
      throw new Error(`no bot action for phase ${state.phase}`);
  }
}

/**
 * Drive one hand from its auction to handScored. The engine auto-redeals
 * dead auctions internally; the oracle's 10k-redeal cap is mirrored here so
 * four timid bidders fail loudly instead of spinning forever.
 */
export function driveHand(
  state: GameState,
  policies: readonly Policy[],
  rng: Rng,
): GameState {
  const baseDeals = state.dealsDrawn;
  while (state.phase !== 'handScored') {
    if (state.dealsDrawn - baseDeals > MAX_REDEALS) {
      throw new Error('auction never produced a contract; check bid policies');
    }
    const action = botAction(state, policies, rng);
    const result = applyAction(state, action);
    if (result.ok) {
      state = result.state;
      continue;
    }
    if (state.phase === 'auction' && action.type === 'bid') {
      // Oracle run_auction: an illegal or too-low bid counts as a pass.
      const pass = applyAction(state, { type: 'bid', seat: action.seat, bid: bid(PASS) });
      if (pass.ok) {
        state = pass.state;
        continue;
      }
    }
    throw new Error(
      `illegal bot action ${action.type} by seat ${action.seat}: ${result.error.message}`,
    );
  }
  return state;
}

export interface ContractStats {
  n: number;
  made: number;
  declPts: number;
  defPts: number;
  slams: number;
}

/** Keyed by contract string plus slam marker, exactly like the oracle. */
export type SimStats = Record<string, ContractStats>;

/**
 * simulateHands result: per-contract stats plus the auction-health counters
 * behind the fh-c6i bid-timidity gates (redeal rate, 7+ contract rate, set
 * rate). `deals` counts every deal drawn including redeals, so
 * `deals - hands` is the number of passed-out auctions.
 */
export interface HandSimResult {
  readonly contracts: SimStats;
  readonly hands: number;
  readonly deals: number;
}

/**
 * Play `n` independent hands (first bidder rotating i % 4 like the oracle)
 * and accumulate per-contract stats plus redeal counts.
 */
export function simulateHands(
  n: number,
  policies: readonly Policy[],
  seed = 0,
): HandSimResult {
  const rng = makeRng(seed);
  const stats: SimStats = {};
  let deals = 0;
  for (let i = 0; i < n; i++) {
    // Each hand is a fresh single-hand game; dealer sits right of bidder i%4.
    let state = newGame(rng.int(0x100000000), (i + 3) % 4);
    state = driveHand(state, policies, rng);
    deals += state.dealsDrawn; // fresh game: hand 0, so this counts redeals too
    const res = state.handResult;
    if (res === null) throw new Error('scored hand is missing its result');
    const key = bidName(res.contract) + (res.slam ? ' +SLAM' : '');
    const s = (stats[key] ??= { n: 0, made: 0, declPts: 0, defPts: 0, slams: 0 });
    s.n += 1;
    s.made += res.made ? 1 : 0;
    s.declPts += res.declarerDelta;
    s.defPts += res.defenderDelta;
    s.slams += res.slam ? 1 : 0;
  }
  return { contracts: stats, hands: n, deals };
}

/** Play one full game on the shared rng stream; returns the winning side. */
function playGame(policies: readonly Policy[], rng: Rng): 0 | 1 {
  let state = newGame(rng.int(0x100000000));
  for (;;) {
    state = driveHand(state, policies, rng);
    if (state.game.winner !== null) {
      return state.game.winner === 0 ? 0 : 1;
    }
    if (state.handNumber + 1 >= MAX_GAME_HANDS) {
      // Oracle play_game fallback: most points wins, ties to side 0.
      return state.game.scores[0] >= state.game.scores[1] ? 0 : 1;
    }
    const next = applyAction(state, { type: 'nextHand', seat: 0 });
    if (!next.ok) throw new Error(`nextHand rejected: ${next.error.message}`);
    state = next.state;
  }
}

/**
 * Play one full game like {@link playGame}, but invoke `onHand` with the
 * scored state after every hand (before the nextHand advance) and return the
 * terminal GameState instead of just the winner. The game-log recorder
 * (packages/learn) consumes each scored hand through `onHand`; sim.ts itself
 * stays free of the log schema and of I/O. RNG usage matches playGame exactly,
 * so a logged run is bit-identical to the unlogged one at the same seed.
 */
export function playGameRecording(
  policies: readonly Policy[],
  rng: Rng,
  seed: number,
  onHand: (state: GameState) => void,
): GameState {
  let state = newGame(seed);
  for (;;) {
    state = driveHand(state, policies, rng);
    onHand(state);
    if (state.game.winner !== null) return state;
    if (state.handNumber + 1 >= MAX_GAME_HANDS) return state; // most points wins
    const next = applyAction(state, { type: 'nextHand', seat: 0 });
    if (!next.ok) throw new Error(`nextHand rejected: ${next.error.message}`);
    state = next.state;
  }
}

/**
 * Play `n` full games and count wins per side (index = seat % 2). First
 * bidder of hand 0 is seat 0 and rotates per hand, like the oracle.
 */
export function simulateGames(
  n: number,
  policies: readonly Policy[],
  seed = 0,
): [number, number] {
  const rng = makeRng(seed);
  const wins: [number, number] = [0, 0];
  for (let i = 0; i < n; i++) {
    wins[playGame(policies, rng)] += 1;
  }
  return wins;
}

/**
 * simulateGames with an event-loop yield between games — bit-identical
 * results (same rng stream), but safe inside vitest workers, where a
 * minutes-long fully synchronous loop starves the worker RPC channel until
 * the run dies with '[vitest-worker]: Timeout calling onTaskUpdate'.
 */
export async function simulateGamesYielding(
  n: number,
  policies: readonly Policy[],
  seed = 0,
): Promise<[number, number]> {
  const rng = makeRng(seed);
  const wins: [number, number] = [0, 0];
  for (let i = 0; i < n; i++) {
    wins[playGame(policies, rng)] += 1;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return wins;
}

/**
 * Auction-health metrics derived from a simulateHands run — the observable
 * gates for the fh-c6i bid-timidity tuning (AC-1 / AC-2):
 *   redealRate     passed-out auctions per deal drawn
 *   contractRate   share of DEALS that produced a 7+ (numbered) contract,
 *                  the strict reading of "hands reaching a 7+ contract" —
 *                  redeals and lose-all contracts both count against it
 *   setRate        failed numbered contracts per numbered contract
 */
export interface AuctionHealth {
  readonly hands: number;
  readonly deals: number;
  readonly redeals: number;
  readonly redealRate: number;
  readonly numContracts: number;
  readonly contractRate: number;
  readonly setRate: number;
}

/** A contract key is a numbered (7+) bid iff it starts with its level. */
const isNumKey = (key: string): boolean => key.charCodeAt(0) >= 0x30 && key.charCodeAt(0) <= 0x39;

export function auctionHealth(result: HandSimResult): AuctionHealth {
  const { contracts, hands, deals } = result;
  const redeals = deals - hands;
  let numContracts = 0;
  let numMade = 0;
  for (const [k, s] of Object.entries(contracts)) {
    if (!isNumKey(k)) continue;
    numContracts += s.n;
    numMade += s.made;
  }
  return {
    hands,
    deals,
    redeals,
    redealRate: deals > 0 ? redeals / deals : 0,
    numContracts,
    contractRate: deals > 0 ? numContracts / deals : 0,
    setRate: numContracts > 0 ? (numContracts - numMade) / numContracts : 0,
  };
}

/** Oracle print_stats table plus the fh-c6i auction-health summary lines. */
export function formatStats(result: HandSimResult): string {
  const rows = Object.entries(result.contracts).sort((a, b) => b[1].n - a[1].n);
  const lines = [
    `${'contract'.padStart(14)} ${'n'.padStart(6)} ${'made%'.padStart(7)} ` +
      `${'avg decl'.padStart(9)} ${'avg def'.padStart(8)}`,
  ];
  for (const [k, s] of rows) {
    lines.push(
      `${k.padStart(14)} ${String(s.n).padStart(6)} ` +
        `${((100 * s.made) / s.n).toFixed(1).padStart(6)}% ` +
        `${(s.declPts / s.n).toFixed(1).padStart(9)} ` +
        `${(s.defPts / s.n).toFixed(1).padStart(8)}`,
    );
  }
  const h = auctionHealth(result);
  const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
  lines.push(
    `hands ${h.hands}  deals ${h.deals}  redeals ${h.redeals} (redeal rate ${pct(h.redealRate)})`,
    `7+ contracts ${h.numContracts}/${h.deals} deals ` +
      `(contract rate ${pct(h.contractRate)})  set rate ${pct(h.setRate)}`,
  );
  return lines.join('\n');
}

export function printStats(result: HandSimResult): void {
  console.log(formatStats(result));
}
