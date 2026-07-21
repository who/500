import { describe, expect, it } from 'vitest';
import { APP_NAME, DEFAULT_PORT, resolvePort } from './index.js';

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
});
