/**
 * Seed picker for the Playwright smoke test (e2e/smoke.test.ts): replays the
 * server's exact bot wiring — EasyPolicy at seats 1–3, per-seat rng seeded
 * makeRng((seed + seat) >>> 0), the human at seat 0 always passing — and
 * prints, per candidate seed, the contract the auction lands on. The smoke
 * test pins TEST_SEED plus its expected contract (e2e/seed.ts); when engine
 * or bot changes shift the stream, rerun this to pick a new seed:
 *
 *   pnpm --filter @five-hundred/bots exec tsx ../../e2e/pick-seed.ts
 *
 * A good smoke seed: a bot declarer (guaranteed — the human never bids), a
 * suit contract (NT could ask the human to name a joker suit, a picker the
 * smoke script does not drive), and zero redeals for speed.
 */

import { EasyPolicy, policyAction } from '../packages/bots/src/index.js';
import {
  applyAction,
  bid,
  bidName,
  newGame,
  makeRng,
  toActSeat,
  trumpOf,
  JOKER,
  PASS,
  legalPlaysFor,
  type Action,
  type GameState,
} from '../packages/engine/src/index.js';

interface Outcome {
  readonly seed: number;
  readonly contract: string;
  readonly declarer: number;
  readonly redeals: number;
  readonly suitContract: boolean;
}

function humanAction(state: GameState): Action {
  if (state.phase === 'auction') return { type: 'bid', seat: 0, bid: bid(PASS) };
  if (state.phase === 'play') {
    const play = state.play;
    if (play === null) throw new Error('play phase without play state');
    const legal = legalPlaysFor(play, 0);
    const card = legal[0];
    if (card === undefined) throw new Error('no legal play for seat 0');
    if (card === JOKER && play.trump === null && play.ledSuit === null) {
      return { type: 'playCard', seat: 0, card, jokerSuit: 0 };
    }
    return { type: 'playCard', seat: 0, card };
  }
  throw new Error(`human asked to act in unexpected phase ${state.phase}`);
}

function simulate(seed: number): Outcome {
  let state = newGame(seed);
  const policies = [null, new EasyPolicy(), new EasyPolicy(), new EasyPolicy()] as const;
  const rngs = [null, makeRng((seed + 1) >>> 0), makeRng((seed + 2) >>> 0), makeRng((seed + 3) >>> 0)];
  let redeals = 0;
  for (let step = 0; step < 5000; step++) {
    if (state.phase === 'handScored') {
      const result = state.handResult;
      if (result === null) throw new Error('handScored without a result');
      return {
        seed,
        contract: bidName(result.contract),
        declarer: result.declarer,
        redeals,
        suitContract: trumpOf(result.contract) !== null,
      };
    }
    const seat = toActSeat(state);
    if (seat === null) throw new Error(`no seat to act during ${state.phase}`);
    const policy = policies[seat];
    const rng = rngs[seat];
    const action =
      policy == null || rng == null ? humanAction(state) : policyAction(state, seat, policy, rng);
    const dealsBefore = state.dealsDrawn;
    const applied = applyAction(state, action);
    if (!applied.ok) throw new Error(`seed ${seed}: rejected ${action.type}: ${applied.error.message}`);
    state = applied.state;
    if (state.dealsDrawn > dealsBefore && state.handNumber === 0) redeals++;
  }
  throw new Error(`seed ${seed}: hand did not finish within 5000 steps`);
}

for (let seed = 1; seed <= 40; seed++) {
  const o = simulate(seed);
  const good = o.suitContract && o.redeals === 0;
  console.log(
    `seed ${String(o.seed).padStart(3)}: ${o.contract} by Bot ${o.declarer + 1}` +
      ` (declarer seat ${o.declarer}, redeals ${o.redeals})${good ? '  <- candidate' : ''}`,
  );
}
