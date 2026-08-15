/**
 * @five-hundred/learn — self-play tuning and calibration for the bots
 * (epic fh-sja). This first slice (fh-sja.2) is the game-log corpus: a
 * versioned JSONL record schema plus a recorder, writer, and validating
 * reader. The arena, tuner, and calibration fitters land in later children
 * and consume the same records.
 */
export const LEARN_NAME = '@five-hundred/learn';

export * from './schema.js';
export * from './record.js';
export * from './writer.js';
export * from './reader.js';
export * from './strength.js';
export * from './calibration.js';
export * from './sprt.js';
export * from './arena.js';
export * from './tuner.js';
export * from './s3.js';
export * from './store.js';
