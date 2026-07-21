/**
 * Shared vitest setup. Component specs opt into jsdom per-file with a
 * `@vitest-environment jsdom` docblock; this file only wires the React 19
 * act() flag and RTL cleanup (vitest runs without globals, so RTL's
 * auto-cleanup never registers itself).
 */

import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});
