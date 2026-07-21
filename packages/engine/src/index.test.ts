import { describe, expect, it } from 'vitest';
import { ENGINE_NAME } from './index.js';

describe('@five-hundred/engine placeholder', () => {
  it('exports the package name', () => {
    expect(ENGINE_NAME).toBe('@five-hundred/engine');
  });
});
