/**
 * The pinned smoke seed, shared by playwright.config.ts (which exports it to
 * the server as TEST_SEED) and smoke.test.ts (which asserts the contract it
 * produces). Asserting the exact contract makes seed drift fail loudly: if
 * engine or bot changes shift the decision stream, rerun e2e/pick-seed.ts
 * and re-pin both values here consciously.
 */

export const TEST_SEED = 2;

/** What seed 2 deals: Bot 2 (seat 1) wins the auction at 7 spades, no redeals. */
export const EXPECTED_CONTRACT = '7S by Bot 2';
