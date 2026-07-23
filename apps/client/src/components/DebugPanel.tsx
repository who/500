/**
 * Debug tools strip below the hand (fh-q2m). Deliberately outside the play
 * chrome: a muted one-line bar carrying the tools themselves, with the
 * fiddly bits (a note field, the running list of what has been flagged)
 * behind a disclosure so casual play sees only the button.
 *
 * The first tool is "flag this trick" — a marker for the spot the player is
 * looking at, usually a bot misplay. Flagging changes nothing about the game;
 * it rides out with the server's end-of-game JSONL record, so the panel's own
 * list is the only feedback there is, and the confirmation line is written
 * optimistically the moment the command goes out.
 */

import { useState, type ReactNode } from 'react';
import { cardName } from '@five-hundred/engine';
import type { FlagTarget } from '../lib/flagTarget.ts';

export interface DebugPanelProps {
  /** The trick a flag would pin, or null when there is none to flag yet. */
  target: FlagTarget | null;
  onFlag(target: FlagTarget, note?: string): void;
}

interface FlaggedEntry extends FlagTarget {
  readonly note?: string;
}

/** Human wording for a marker: tricks and hands count from 1 on screen. */
export function flagLabel(target: FlagTarget): string {
  return `hand ${target.hand + 1}, trick ${target.trick + 1}`;
}

/**
 * The play the flag lands on, worded the way the log words it (fh-g4g): a
 * 0-based *engine* seat, deliberately not the felt's player names. The one
 * place in the UI that speaks the corpus's dialect, so a note typed here is
 * about the same seat the marker records. Empty when the trick has no card in
 * it yet.
 */
export function flagPlayLabel(target: FlagTarget): string {
  const play = target.play;
  return play === undefined ? '' : `seat ${play.seat} played ${cardName(play.card)}`;
}

/** `flagLabel`, with the flagged play appended when there is one. */
function flagFullLabel(target: FlagTarget): string {
  const play = flagPlayLabel(target);
  return play === '' ? flagLabel(target) : `${flagLabel(target)} — ${play}`;
}

export function DebugPanel(props: DebugPanelProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [flagged, setFlagged] = useState<readonly FlaggedEntry[]>([]);
  const target = props.target;

  function flag(): void {
    if (target === null) return;
    const trimmed = note.trim();
    props.onFlag(target, trimmed === '' ? undefined : trimmed);
    setFlagged((prev) => [...prev, { ...target, ...(trimmed === '' ? {} : { note: trimmed }) }]);
    setNote('');
  }

  const last = flagged[flagged.length - 1];
  return (
    <section className="debug-panel" aria-label="Debug tools" data-testid="debug-panel">
      <div className="debug-tools">
        <button
          type="button"
          className="debug-flag"
          data-testid="flag-trick"
          disabled={target === null}
          title={
            target === null
              ? 'Nothing to flag until a card is played'
              : `Flag ${flagFullLabel(target)}`
          }
          onClick={flag}
        >
          ⚑ Flag this trick
        </button>
        <button
          type="button"
          className="debug-disclosure"
          data-testid="debug-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          Tools {open ? '▾' : '▸'}
        </button>
      </div>
      <p className="debug-status" role="status" data-testid="flag-status">
        {last === undefined ? '' : `Flagged ${flagFullLabel(last)}`}
      </p>
      {open && (
        <div className="debug-drawer">
          <p className="debug-target" data-testid="flag-target">
            {target === null ? 'Nothing to flag yet' : flagFullLabel(target)}
          </p>
          <label className="debug-note">
            Note
            <input
              type="text"
              data-testid="flag-note"
              value={note}
              maxLength={200}
              placeholder="what looked wrong?"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <ul className="debug-flag-list" data-testid="flag-list">
            {flagged.map((f, i) => (
              <li key={`${f.hand}-${f.trick}-${i}`}>
                {flagFullLabel(f)}
                {f.note === undefined ? '' : ` — ${f.note}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
