// @vitest-environment jsdom

/**
 * Theme layer spec (PRD 6.3 / AC-1): prefers-color-scheme drives the default,
 * the manual toggle pins a scheme via data-theme and persists it across
 * reloads, and the suit/danger tokens in index.css hold WCAG AA contrast in
 * both schemes (the ratio math runs here — jsdom cannot render color).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_STORAGE_KEY, currentTheme, initTheme, storedTheme, toggleTheme } from './theme.ts';
import { installFakeLocalStorage } from './screens/test-helpers.tsx';

function stubMatchMedia(dark: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: dark && query.includes('dark'),
    media: query,
  }));
}

let storage: Map<string, string>;

beforeEach(() => {
  storage = installFakeLocalStorage();
  stubMatchMedia(false);
  delete document.documentElement.dataset['theme'];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('theme default', () => {
  it('follows prefers-color-scheme when nothing is stored', () => {
    stubMatchMedia(true);
    expect(initTheme()).toBe('dark');
    // No pin: the attribute stays off so the OS preference tracks live.
    expect(document.documentElement.dataset['theme']).toBeUndefined();

    stubMatchMedia(false);
    expect(initTheme()).toBe('light');
    expect(currentTheme()).toBe('light');
  });

  it('ignores an invalid stored value', () => {
    storage.set(THEME_STORAGE_KEY, 'sepia');
    expect(storedTheme()).toBeNull();
    expect(initTheme()).toBe('light');
    expect(document.documentElement.dataset['theme']).toBeUndefined();
  });
});

describe('theme toggle', () => {
  it('pins the opposite scheme on <html> and persists it', () => {
    expect(toggleTheme()).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('dark');

    expect(toggleTheme()).toBe('light');
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('light');
  });

  it('overrides the system preference once pinned', () => {
    stubMatchMedia(true); // OS says dark…
    storage.set(THEME_STORAGE_KEY, 'light'); // …but the user pinned light.
    expect(initTheme()).toBe('light');
    expect(document.documentElement.dataset['theme']).toBe('light');
  });

  it('restores the pin across a reload (AC-1 persistence)', () => {
    toggleTheme(); // pins dark (system default is light)
    delete document.documentElement.dataset['theme']; // "reload"
    expect(initTheme()).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });
});

// --- AA contrast of the color tokens (AC-1) -------------------------------

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'index.css'),
  'utf8',
);

/** The (light, dark) pair a token resolves to via light-dark(). */
function tokenPair(name: string): [string, string] {
  const match = new RegExp(`--${name}:\\s*light-dark\\(([^,]+),\\s*([^)]+)\\)`).exec(CSS);
  if (match === null) throw new Error(`token --${name} not found as light-dark() in index.css`);
  return [match[1].trim(), match[2].trim()];
}

function channel(hex: string, i: number): number {
  const digits = hex.length === 4 ? hex[i + 1] + hex[i + 1] : hex.slice(1 + 2 * i, 3 + 2 * i);
  const c = parseInt(digits, 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x contrast ratio between two hex colors. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number =>
    0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('token contrast (WCAG AA, both schemes)', () => {
  const AA = 4.5;

  it.each([
    ['suit-red', 'card-ground'],
    ['suit-black', 'card-ground'],
    ['joker', 'card-ground'],
  ])('--%s on --%s reaches AA on the card face', (fg, bg) => {
    const [fgLight, fgDark] = tokenPair(fg);
    const [bgLight, bgDark] = tokenPair(bg);
    expect(contrast(fgLight, bgLight)).toBeGreaterThanOrEqual(AA);
    expect(contrast(fgDark, bgDark)).toBeGreaterThanOrEqual(AA);
  });

  it('--danger reaches AA on the app background', () => {
    const [fgLight, fgDark] = tokenPair('danger');
    const [bgLight, bgDark] = tokenPair('bg');
    expect(contrast(fgLight, bgLight)).toBeGreaterThanOrEqual(AA);
    expect(contrast(fgDark, bgDark)).toBeGreaterThanOrEqual(AA);
  });

  it('--text-h reaches AA on the app background', () => {
    const [fgLight, fgDark] = tokenPair('text-h');
    const [bgLight, bgDark] = tokenPair('bg');
    expect(contrast(fgLight, bgLight)).toBeGreaterThanOrEqual(AA);
    expect(contrast(fgDark, bgDark)).toBeGreaterThanOrEqual(AA);
  });
});
