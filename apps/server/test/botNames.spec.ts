/**
 * fh-1ni: the bot-name picker. The only contract that matters is "never hand
 * back a name this room already uses" — the draw itself is unseeded on
 * purpose, so the tests pin behavior, not a particular sequence.
 */
import { describe, expect, it } from 'vitest';
import { BOT_NAMES, pickBotName } from '../src/botNames.js';

describe('pickBotName (fh-1ni)', () => {
  it('draws from the pool and avoids names already taken', () => {
    const taken: string[] = [];
    // Three bots is the room maximum; every draw must be fresh.
    for (let i = 0; i < 3; i++) {
      const name = pickBotName(taken);
      expect(BOT_NAMES).toContain(name);
      expect(taken).not.toContain(name);
      taken.push(name);
    }
  });

  it('spans the whole pool rather than favouring one end', () => {
    // Deterministic sweep: each position of the free pool is reachable.
    const drawn = BOT_NAMES.map((_, i) => pickBotName([], () => i / BOT_NAMES.length));
    expect(drawn).toEqual([...BOT_NAMES]);
  });

  it('still returns a name when the pool is exhausted', () => {
    expect(BOT_NAMES).toContain(pickBotName(BOT_NAMES));
  });
});
