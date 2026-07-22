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
          { seat, indications: auction.indications },
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
 * Play `n` independent hands (first bidder rotating i % 4 like the oracle)
 * and accumulate per-contract stats.
 */
export function simulateHands(n: number, policies: readonly Policy[], seed = 0): SimStats {
  const rng = makeRng(seed);
  const stats: SimStats = {};
  for (let i = 0; i < n; i++) {
    // Each hand is a fresh single-hand game; dealer sits right of bidder i%4.
    let state = newGame(rng.int(0x100000000), (i + 3) % 4);
    state = driveHand(state, policies, rng);
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
  return stats;
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
    let state = newGame(rng.int(0x100000000));
    for (;;) {
      state = driveHand(state, policies, rng);
      if (state.game.winner !== null) {
        wins[state.game.winner === 0 ? 0 : 1] += 1;
        break;
      }
      if (state.handNumber + 1 >= MAX_GAME_HANDS) {
        // Oracle play_game fallback: most points wins, ties to side 0.
        wins[state.game.scores[0] >= state.game.scores[1] ? 0 : 1] += 1;
        break;
      }
      const next = applyAction(state, { type: 'nextHand', seat: 0 });
      if (!next.ok) throw new Error(`nextHand rejected: ${next.error.message}`);
      state = next.state;
    }
  }
  return wins;
}

/** Oracle print_stats table, returned as a string (printStats logs it). */
export function formatStats(stats: SimStats): string {
  const rows = Object.entries(stats).sort((a, b) => b[1].n - a[1].n);
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
  return lines.join('\n');
}

export function printStats(stats: SimStats): void {
  console.log(formatStats(stats));
}
