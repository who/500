/**
 * Injectable seeded RNG — the only randomness entry point for the engine
 * and bots; no engine code touches ambient randomness or the clock.
 *
 * mulberry32 over a 32-bit seed: pure >>> arithmetic (no BigInt), so the
 * stream is identical in Node and browsers. No attempt is made to match
 * CPython's Mersenne Twister; parity testing replays recorded deals.
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  random(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** In-place Fisher-Yates shuffle. */
  shuffle<T>(arr: T[]): void;
}

export function makeRng(seed: number): Rng {
  let state = seed >>> 0;

  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (n: number): number => Math.floor(random() * n);

  const shuffle = <T>(arr: T[]): void => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = int(i + 1);
      const tmp = arr[i] as T;
      arr[i] = arr[j] as T;
      arr[j] = tmp;
    }
  };

  return { random, int, shuffle };
}
