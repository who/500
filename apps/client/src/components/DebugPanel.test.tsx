// @vitest-environment jsdom

/**
 * Debug tools panel (fh-q2m): the marker button in isolation. The panel owns
 * no game state — it reports the target it was handed and remembers what it
 * has flagged — so these cases cover the button's contract, the optional
 * note, and the local feedback (confirmation line + list).
 */

import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DebugPanel, flagLabel } from './DebugPanel.tsx';
import { flagTarget } from '../lib/flagTarget.ts';
import type { RedactedView } from '@five-hundred/engine';

const TARGET = { hand: 2, trick: 5 };

describe('DebugPanel', () => {
  it('flags the target it was given, with no note by default (AC-1)', () => {
    const onFlag = vi.fn();
    const app = render(<DebugPanel target={TARGET} onFlag={onFlag} />);

    fireEvent.click(app.getByTestId('flag-trick'));

    expect(onFlag).toHaveBeenCalledTimes(1);
    expect(onFlag).toHaveBeenCalledWith(TARGET, undefined);
    // Optimistic confirmation: 1-based wording for the human.
    expect(app.getByTestId('flag-status').textContent).toBe('Flagged hand 3, trick 6');
  });

  it('passes the typed note along and clears the field', () => {
    const onFlag = vi.fn();
    const app = render(<DebugPanel target={TARGET} onFlag={onFlag} />);

    fireEvent.click(app.getByTestId('debug-toggle'));
    const note = app.getByTestId('flag-note') as HTMLInputElement;
    fireEvent.change(note, { target: { value: '  bot trumped its partner  ' } });
    fireEvent.click(app.getByTestId('flag-trick'));

    expect(onFlag).toHaveBeenCalledWith(TARGET, 'bot trumped its partner');
    expect(note.value).toBe('');
  });

  it('keeps the note field and flag list behind the disclosure', () => {
    const app = render(<DebugPanel target={TARGET} onFlag={() => {}} />);

    expect(app.queryByTestId('flag-note')).toBeNull();
    expect(app.getByTestId('debug-toggle').getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(app.getByTestId('flag-trick'));
    fireEvent.click(app.getByTestId('debug-toggle'));

    expect(app.getByTestId('debug-toggle').getAttribute('aria-expanded')).toBe('true');
    const items = [...app.getByTestId('flag-list').querySelectorAll('li')];
    expect(items.map((li) => li.textContent)).toEqual(['hand 3, trick 6']);
  });

  it('disables the button when there is nothing on screen to flag', () => {
    const app = render(<DebugPanel target={null} onFlag={() => {}} />);
    expect((app.getByTestId('flag-trick') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('flagTarget', () => {
  const view = (o: Partial<RedactedView>): RedactedView => o as RedactedView;

  it('pins the trick in progress while cards are going down', () => {
    expect(
      flagTarget(view({ handNumber: 1, tricksPlayed: 3, trick: { leader: 0, ledSuit: 0, plays: [] } })),
    ).toEqual({ hand: 1, trick: 3 });
  });

  it('pins the trick just resolved while the felt still shows it', () => {
    expect(flagTarget(view({ handNumber: 1, tricksPlayed: 4, trick: null }))).toEqual({
      hand: 1,
      trick: 3,
    });
  });

  it('has nothing to pin before the first card', () => {
    expect(flagTarget(view({ handNumber: 0, tricksPlayed: 0, trick: null }))).toBeNull();
  });

  it('labels markers from 1 for the human', () => {
    expect(flagLabel({ hand: 0, trick: 0 })).toBe('hand 1, trick 1');
  });
});
