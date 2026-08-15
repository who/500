import { describe, expect, it } from 'vitest';
import {
  CARDS_PER_PLAYER,
  DEAL_TOTAL,
  MAX_PACKET,
  MIDDLE_CARDS,
  RECIPES,
  cardJitter,
  clockwiseFromDealer,
  trickPoseKey,
  trickRestPose,
  dealSeed,
  expandPackets,
  pickRecipeIndex,
  recipeTotals,
} from './dealPattern.ts';

describe('dealPattern recipes', () => {
  it.each(RECIPES.map((recipe, i) => [i + 1, recipe] as const))(
    'recipe %s totals 45, 10 each, 5 middle, and never deals more than 3',
    (_n, recipe) => {
      const { total, max, perPlayer, middle } = recipeTotals(recipe);
      expect(total).toBe(DEAL_TOTAL);
      expect(total).toBe(45);
      expect(max).toBeLessThanOrEqual(MAX_PACKET);
      expect(max).toBeLessThanOrEqual(3);
      expect(perPlayer).toBe(CARDS_PER_PLAYER);
      expect(middle).toBe(MIDDLE_CARDS);
      for (const rot of recipe) {
        expect(rot.n).toBeGreaterThan(0);
        expect(rot.n).toBeLessThanOrEqual(3);
        expect(rot.middle).toBeGreaterThanOrEqual(0);
        expect(rot.middle).toBeLessThanOrEqual(3);
      }
    },
  );

  it('deals left of the dealer first, then clockwise, middle last in the packet', () => {
    expect(clockwiseFromDealer(3)).toEqual([0, 1, 2, 3]);
    expect(clockwiseFromDealer(0)).toEqual([1, 2, 3, 0]);
    const packets = expandPackets(RECIPES[0] as (typeof RECIPES)[0], 3);
    expect(packets.slice(0, 5)).toEqual([
      { dest: { kind: 'seat', seat: 0 }, count: 3 },
      { dest: { kind: 'seat', seat: 1 }, count: 3 },
      { dest: { kind: 'seat', seat: 2 }, count: 3 },
      { dest: { kind: 'seat', seat: 3 }, count: 3 },
      { dest: { kind: 'middle' }, count: 3 },
    ]);
    const dealt = packets.reduce((n, p) => n + p.count, 0);
    expect(dealt).toBe(45);
  });

  it('picks a recipe and jitter deterministically from the seed', () => {
    const seed = dealSeed(2, 1, 3);
    expect(pickRecipeIndex(seed)).toBe(pickRecipeIndex(seed));
    expect(pickRecipeIndex(dealSeed(0, 0, 0))).not.toBe(pickRecipeIndex(dealSeed(1, 0, 0)));
    const a = cardJitter(seed, 0, 0);
    const b = cardJitter(seed, 0, 0);
    expect(a).toEqual(b);
    expect(Math.abs(a.rotate)).toBeGreaterThanOrEqual(8);
    expect(Math.abs(a.rotate)).toBeLessThanOrEqual(15);
  });

  it('lands a trick rest pose in the spec ranges and keeps it across linger remount', () => {
    const liveKey = trickPoseKey(2, 3, true);
    const lingerKey = trickPoseKey(2, 4, false);
    expect(liveKey).toBe(lingerKey);
    expect(trickPoseKey(2, 4, true)).not.toBe(liveKey);

    const a = trickRestPose(1, 14, liveKey);
    const b = trickRestPose(1, 14, lingerKey);
    expect(a).toEqual(b);
    expect(Math.abs(a.rotate)).toBeGreaterThanOrEqual(8);
    expect(Math.abs(a.rotate)).toBeLessThanOrEqual(18);
    expect(Math.abs(a.x)).toBeGreaterThanOrEqual(4);
    expect(Math.abs(a.x)).toBeLessThanOrEqual(10);
    expect(Math.abs(a.y)).toBeGreaterThanOrEqual(4);
    expect(Math.abs(a.y)).toBeLessThanOrEqual(10);
    expect(trickRestPose(1, 14, trickPoseKey(3, 3, true))).not.toEqual(a);
  });
});
