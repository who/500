import { describe, expect, it } from 'vitest';
import {
  candidateParams,
  equalParams,
  parseAbBowerArgs,
} from '../src/ab-bower.js';

describe('ab-bower overlays', () => {
  it('defaults to right 0.95 / left 0.90 against equal 0.95', () => {
    const opts = parseAbBowerArgs([]);
    const a = candidateParams(opts);
    const b = equalParams(opts);
    expect(a.suitStrength.rightBower).toBe(0.95);
    expect(a.suitStrength.leftBower).toBe(0.9);
    expect(a.hardMemory.rightBowerSalience).toBe(0.95);
    expect(a.hardMemory.leftBowerSalience).toBe(0.9);
    expect(b.suitStrength.rightBower).toBe(0.95);
    expect(b.suitStrength.leftBower).toBe(0.95);
    expect(b.hardMemory.rightBowerSalience).toBe(0.95);
    expect(b.hardMemory.leftBowerSalience).toBe(0.95);
  });

  it('--strength-only leaves memory equal to the shipped defaults', () => {
    const opts = parseAbBowerArgs(['--strength-only', '--left', '0.5']);
    const a = candidateParams(opts);
    expect(a.suitStrength.leftBower).toBe(0.5);
    expect(a.hardMemory.leftBowerSalience).toBe(0.95);
    expect(a.hardMemory.rightBowerSalience).toBe(0.95);
  });

  it('rejects combining --strength-only and --memory-only', () => {
    expect(() => parseAbBowerArgs(['--strength-only', '--memory-only'])).toThrow(/only one/);
  });
});
