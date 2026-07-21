import { describe, expect, it } from 'vitest';
import { APP_NAME, DEFAULT_PORT, resolvePort } from './index.js';
import { testSeed } from './ws.js';

describe('@five-hundred/server placeholder', () => {
  it('is named Five Hundred and defaults to port 8500', () => {
    expect(APP_NAME).toBe('Five Hundred');
    expect(DEFAULT_PORT).toBe(8500);
  });

  it('resolves PORT from the environment with an 8500 default', () => {
    expect(resolvePort({})).toBe(8500);
    expect(resolvePort({ PORT: '9000' })).toBe(9000);
    expect(() => resolvePort({ PORT: 'nope' })).toThrow(/Invalid PORT/);
  });

  it('honors TEST_SEED only when set to a valid 32-bit integer', () => {
    expect(testSeed({})).toBeNull();
    expect(testSeed({ TEST_SEED: '' })).toBeNull();
    expect(testSeed({ TEST_SEED: '2' })).toBe(2);
    expect(testSeed({ TEST_SEED: '4294967295' })).toBe(4294967295);
    expect(() => testSeed({ TEST_SEED: 'nope' })).toThrow(/Invalid TEST_SEED/);
    expect(() => testSeed({ TEST_SEED: '-1' })).toThrow(/Invalid TEST_SEED/);
    expect(() => testSeed({ TEST_SEED: '4294967296' })).toThrow(/Invalid TEST_SEED/);
  });
});
