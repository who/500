/**
 * @five-hundred/protocol — shared client/server message and view types.
 *
 * Types only, plus the hand-rolled guards in guards.ts (the package's sole
 * runtime code): commands, events, the seq-carrying envelope, error codes,
 * and the per-seat room/game views.
 */
export const PROTOCOL_NAME = '@five-hundred/protocol';
export const PROTOCOL_VERSION = 1;

export * from './messages.js';
export * from './views.js';
export * from './guards.js';
