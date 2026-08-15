import { describe, expect, it } from 'vitest';
import { DNULLA, NULLA, NUM, bid } from '@five-hundred/engine';
import { contractToken } from './contractToken.ts';

describe('contractToken', () => {
  it('matches the HUD strong-text rules', () => {
    expect(contractToken(bid(NUM, 8, 3), false)).toBe('8H');
    expect(contractToken(bid(NUM, 8, 3), true)).toBe('Slam 8H');
    expect(contractToken(bid(NULLA), false)).toBe('Nulla 250');
    expect(contractToken(bid(DNULLA), false)).toBe('Double Nulla 500');
    expect(contractToken(bid(NUM, 10, 4), true)).toBe('Slam 10NT');
  });
});
