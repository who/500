import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@five-hundred/protocol';

describe('@five-hundred/client placeholder', () => {
  it('resolves the workspace dependency on the protocol package', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
