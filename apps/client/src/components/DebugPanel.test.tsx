// @vitest-environment jsdom

/**
 * Debug tools panel (fh-q2m): the marker button in isolation. The panel owns
 * no game state — it reports the target it was handed and remembers what it
 * has flagged — so these cases cover the button's contract, the optional
 * note, and the local feedback (confirmation line + list).
 */

import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DebugPanel, flagLabel, flagPlayLabel } from './DebugPanel.tsx';
import { flagTarget } from '../lib/flagTarget.ts';
import { cardName, type RedactedView, type TrickPlay } from '@five-hundred/engine';

const TARGET = { hand: 2, trick: 5 };
/** Engine seat 2 — the seat the felt labels "Bot 3" (fh-g4g). */
const PLAY: TrickPlay = { seat: 2, card: 17 };
const PLAYED = `seat 2 played ${cardName(17)}`;

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

  /**
   * fh-g4g. The panel is the one spot in the UI that speaks the log's dialect:
   * 0-based engine seats. Everywhere else says "Bot 3" for engine seat 2, and
   * a note typed from that wording is off by one against every other field in
   * the corpus — so the seat the flag lands on is shown while it is typed.
   */
  it('names the flagged play by 0-based engine seat, not the Bot N label', () => {
    const target = { ...TARGET, play: PLAY };
    const app = render(<DebugPanel target={target} onFlag={() => {}} />);

    fireEvent.click(app.getByTestId('debug-toggle'));
    expect(app.getByTestId('flag-target').textContent).toBe(`hand 3, trick 6 — ${PLAYED}`);
    expect(app.getByTestId('flag-trick').getAttribute('title')).toBe(
      `Flag hand 3, trick 6 — ${PLAYED}`,
    );

    fireEvent.click(app.getByTestId('flag-trick'));

    expect(app.getByTestId('flag-status').textContent).toBe(`Flagged hand 3, trick 6 — ${PLAYED}`);
    const items = [...app.getByTestId('flag-list').querySelectorAll('li')];
    expect(items.map((li) => li.textContent)).toEqual([`hand 3, trick 6 — ${PLAYED}`]);
  });

  it('says only what it knows when the flagged trick has no card in it yet', () => {
    const app = render(<DebugPanel target={TARGET} onFlag={() => {}} />);
    fireEvent.click(app.getByTestId('debug-toggle'));
    expect(app.getByTestId('flag-target').textContent).toBe('hand 3, trick 6');
    expect(flagPlayLabel(TARGET)).toBe('');
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

  it('carries the last card down in the trick in progress (fh-g4g)', () => {
    expect(
      flagTarget(
        view({
          handNumber: 1,
          tricksPlayed: 3,
          trick: { leader: 1, ledSuit: 0, plays: [{ seat: 1, card: 5 }, PLAY] },
        }),
      ),
    ).toEqual({ hand: 1, trick: 3, play: PLAY });
  });

  it('carries the last card of the trick just resolved, since that is what is on the felt', () => {
    expect(
      flagTarget(
        view({
          handNumber: 1,
          tricksPlayed: 4,
          trick: null,
          lastTrick: { leader: 1, ledSuit: 0, plays: [{ seat: 1, card: 5 }, PLAY], winner: 2 },
        }),
      ),
    ).toEqual({ hand: 1, trick: 3, play: PLAY });
  });
});
