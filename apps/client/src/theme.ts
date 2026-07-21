/**
 * Theme layer (PRD 6.3): the CSS tokens in index.css resolve through
 * light-dark(), so by default the app follows prefers-color-scheme live. A
 * manual toggle pins one scheme by setting data-theme on <html> (which flips
 * color-scheme via CSS) and persists the pin in localStorage; with no stored
 * pin, no attribute is set and the OS preference stays in charge.
 */

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'five-hundred.theme';

/** The OS-level preference, defaulting to light where matchMedia is absent. */
export function systemTheme(): Theme {
  try {
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** The persisted manual pin, or null when the user never toggled. */
export function storedTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    return null;
  }
}

/** The theme in effect right now: manual pin first, else the OS preference. */
export function currentTheme(): Theme {
  return storedTheme() ?? systemTheme();
}

function applyTheme(theme: Theme | null): void {
  const root = document.documentElement;
  if (theme === null) delete root.dataset['theme'];
  else root.dataset['theme'] = theme;
}

/** Restore a persisted pin on startup; returns the theme now in effect. */
export function initTheme(): Theme {
  const pinned = storedTheme();
  applyTheme(pinned);
  return pinned ?? systemTheme();
}

/** Flip to the other theme, pin it, and persist; returns the new theme. */
export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Privacy modes: the pin just won't survive a reload.
  }
  return next;
}
