/**
 * fh-1ni: bot seats carry an individual identity instead of a generic "Bot"
 * label — a common American first name drawn when the seat becomes a bot and
 * kept for the life of the room. Cosmetic only: the stored name is bare
 * ("Emma") and the client renders the "AI " prefix, so nothing downstream has
 * to strip it.
 *
 * This is not the deterministic engine — no seeded Rng here on purpose; a
 * room's bot names have no bearing on replay.
 */

/** Common American first names, deliberately larger than the 3 bot seats. */
export const BOT_NAMES = [
  'Emma',
  'Liam',
  'Olivia',
  'Noah',
  'Ava',
  'Marcus',
  'Sophia',
  'Ethan',
  'Isabella',
  'Mason',
  'Mia',
  'Jackson',
  'Harper',
  'Caleb',
  'Grace',
  'Owen',
  'Chloe',
  'Nathan',
  'Ruby',
  'Wyatt',
  'Nora',
  'Elijah',
  'Hazel',
  'Jonah',
] as const;

/**
 * A name for a new bot seat, avoiding the ones this room already uses so the
 * (up to 3) bots stay distinguishable. Falls back to the full pool if every
 * name is somehow taken — a name is a label, never a key.
 */
export function pickBotName(taken: Iterable<string> = [], random: () => number = Math.random): string {
  const used = new Set(taken);
  const free = BOT_NAMES.filter((n) => !used.has(n));
  const pool: readonly string[] = free.length > 0 ? free : BOT_NAMES;
  return pool[Math.floor(random() * pool.length)] ?? BOT_NAMES[0];
}
