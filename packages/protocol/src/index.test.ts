import { describe, expect, it } from 'vitest';
import { PROTOCOL_NAME, PROTOCOL_VERSION } from './index.js';

describe('@five-hundred/protocol placeholder', () => {
  it('exports the package name and version', () => {
    expect(PROTOCOL_NAME).toBe('@five-hundred/protocol');
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
