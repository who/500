/**
 * Seed picker for the Playwright smoke test (e2e/smoke.test.ts): replays the
 * server's exact bot wiring — HardPolicy at seats 1–3 (fh-gpk: the product
 * only ever spawns Hard bots), each decision seeded the way the worker pool
 * seeds it (game seed + a running decision count across all Hard seats, see
 * BotDriver.decide), the human at seat 0 always passing — and prints, per
 * candidate seed, the contract the auction lands on. The smoke test pins
 * TEST_SEED plus its expected contract (e2e/seed.ts); when engine or bot
 * changes shift the stream, rerun this to pick a new seed:
 *
 *   pnpm --filter @five-hundred/bots exec tsx ../../e2e/pick-seed.ts
 *
 * A good smoke seed: a bot declarer at SEAT 1 (so the declarer's lead puts
 * the human last to trick 1 — scaleup.test.ts measures that frozen state), a
 * suit contract (NT could ask the human to name a joker suit, a picker the
 * smoke script does not drive), no slam, and zero redeals for speed.
 *
 * Only the auction and the exchange are replayed: those run on fixed world
 * counts and so are reproducible from the seed alone. Card play is the one
 * wall-clock-budgeted decision (hardPool's deadlineMs), which is why the
 * smoke test asserts the contract but never a specific played card.
 */

import { HardPolicy, policyAction } from '../packages/bots/src/index.js';
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
  readonly slam: boolean;
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
  const policy = new HardPolicy();
  /** Mirrors BotDriver's hardDecisions counter: one stream for all Hard seats. */
  let decisions = 0;
  let redeals = 0;
  for (let step = 0; step < 5000; step++) {
    // The contract is settled once play begins; card play is budget-bound
    // (non-reproducible), so the replay stops here.
    if (state.phase === 'play') {
      const contract = state.contract;
      const declarer = state.declarer;
      if (contract === null || declarer === null) throw new Error('play without a contract');
      return {
        seed,
        contract: bidName(contract),
        declarer,
        redeals,
        suitContract: trumpOf(contract) !== null,
        slam: state.slam,
      };
    }
    const seat = toActSeat(state);
    if (seat === null) throw new Error(`no seat to act during ${state.phase}`);
    const action =
      seat === 0
        ? humanAction(state)
        : policyAction(state, seat, policy, makeRng((seed + decisions++) >>> 0));
    const dealsBefore = state.dealsDrawn;
    const applied = applyAction(state, action);
    if (!applied.ok) throw new Error(`seed ${seed}: rejected ${action.type}: ${applied.error.message}`);
    state = applied.state;
    if (state.dealsDrawn > dealsBefore && state.handNumber === 0) redeals++;
  }
  throw new Error(`seed ${seed}: hand did not reach play within 5000 steps`);
}

for (let seed = 1; seed <= 40; seed++) {
  const o = simulate(seed);
  const good = o.suitContract && o.redeals === 0 && !o.slam && o.declarer === 1;
  console.log(
    `seed ${String(o.seed).padStart(3)}: ${o.contract} by seat ${o.declarer}` +
      ` (declarer seat ${o.declarer}, redeals ${o.redeals}, slam ${o.slam})` +
      `${good ? '  <- candidate' : ''}`,
  );
}
