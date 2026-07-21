import { describe, expect, it } from 'vitest';
import { BOTS_NAME, engineDependencyName } from './index.js';

describe('@five-hundred/bots placeholder', () => {
  it('exports the package name', () => {
    expect(BOTS_NAME).toBe('@five-hundred/bots');
  });

  it('resolves the workspace dependency on the engine', () => {
    expect(engineDependencyName()).toBe('@five-hundred/engine');
  });
});
