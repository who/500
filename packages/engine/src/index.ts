/**
 * @five-hundred/engine — pure rules engine for the Five Hundred card game.
 *
 * The Python oracle (five_hundred.py at the repo root) is the reference
 * implementation; every module here must match it exactly.
 */
export const ENGINE_NAME = '@five-hundred/engine';

export * from './cards.js';
export * from './bids.js';
export * from './rng.js';
export * from './auction.js';
export * from './deal.js';
