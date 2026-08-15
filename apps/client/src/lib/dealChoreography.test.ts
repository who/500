import { describe, expect, it } from 'vitest';
import { expandPackets, pickRecipe } from './dealPattern.ts';
import { dealReducer, startDeal, type DealState } from './dealChoreography.ts';

const seed = 1;
const recipe = pickRecipe(seed);
const packets = expandPackets(recipe, 3);

function dealing(): DealState {
  return startDeal('auction', '0:0', seed, recipe, packets, false);
}

describe('dealReducer', () => {
  it('starts a fresh auction dealing, or snaps under reduced motion', () => {
    const live = startDeal('auction', '0:0', seed, recipe, packets, false);
    expect(live.seq).toBe('dealing');
    expect(live.landed).toEqual([0, 0, 0, 0]);
    expect(live.middleLanded).toBe(0);

    const snap = startDeal('auction', '0:0', seed, recipe, packets, true);
    expect(snap.seq).toBe('holding');
    expect(snap.landed).toEqual([10, 10, 10, 10]);
    expect(snap.middleLanded).toBe(5);

    const play = startDeal('play', '0:0', seed, recipe, packets, false);
    expect(play.seq).toBe('done');
    expect(play.middleLanded).toBe(0);
  });

  it('grows counts as packets land, skip jumps to the dealt state, toast starts pickup', () => {
    let s = dealing();
    s = dealReducer(s, { type: 'land', packet: { dest: { kind: 'seat', seat: 0 }, count: 3 } });
    s = dealReducer(s, { type: 'land', packet: { dest: { kind: 'middle' }, count: 3 } });
    expect(s.landed[0]).toBe(3);
    expect(s.middleLanded).toBe(3);

    s = dealReducer(s, { type: 'skip' });
    expect(s.seq).toBe('holding');
    expect(s.landed).toEqual([10, 10, 10, 10]);
    expect(s.middleLanded).toBe(5);

    s = dealReducer(s, { type: 'toastGone', declarer: 2, reduced: false });
    expect(s.seq).toBe('pickup');
    s = dealReducer(s, { type: 'pickupDone' });
    expect(s.seq).toBe('done');
    expect(s.middleLanded).toBe(0);
  });

  it('replays on a new hand key and cancels an in-flight deal when the phase leaves auction', () => {
    let s = dealing();
    s = dealReducer(s, { type: 'land', packet: { dest: { kind: 'seat', seat: 1 }, count: 2 } });
    s = dealReducer(s, {
      type: 'sync',
      key: '0:1',
      phase: 'auction',
      seed,
      recipe,
      packets,
      reduced: false,
      middleCount: 5,
    });
    expect(s.key).toBe('0:1');
    expect(s.seq).toBe('dealing');
    expect(s.landed).toEqual([0, 0, 0, 0]);

    s = dealReducer(s, { type: 'land', packet: { dest: { kind: 'seat', seat: 0 }, count: 1 } });
    s = dealReducer(s, {
      type: 'sync',
      key: '0:1',
      phase: 'slamDecision',
      seed,
      recipe,
      packets,
      reduced: false,
      middleCount: 5,
    });
    expect(s.seq).toBe('holding');
    expect(s.middleLanded).toBe(5);
  });
});
