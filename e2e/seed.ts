/**
 * The pinned smoke seed, shared by playwright.config.ts (which exports it to
 * the server as TEST_SEED) and smoke.test.ts (which asserts the contract it
 * produces). Asserting the exact contract makes seed drift fail loudly: if
 * engine or bot changes shift the decision stream, rerun e2e/pick-seed.ts
 * and re-pin both values here consciously.
 *
 * The stream is the Hard bots' (fh-gpk: every seat the server fills is Hard).
 * Only the auction and the exchange are pinned — those run on fixed world
 * counts; card play is wall-clock-budgeted, so no played card is asserted.
 */

export const TEST_SEED = 9;

/** What seed 9 deals: Bot 2 (seat 1) wins the auction at 7 spades, no redeals. */
export const EXPECTED_CONTRACT = '7S by Bot 2';

/**
 * Hard's per-decision rollout budget for e2e (server env HARD_BOT_BUDGET_MS).
 * Production defaults to 1000ms; a browser run plays ~30 bot cards a hand, so
 * the suite trims the budget to keep the whole run near two minutes while
 * still exercising the real worker-pool rollout path.
 */
export const TEST_HARD_BUDGET_MS = 250;
