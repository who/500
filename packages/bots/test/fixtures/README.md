# Bot parity fixtures

## medium-decisions.jsonl

Committed 100-context HeuristicPolicy decision fixture replayed by
`medium.spec.ts` on every `pnpm test` run (fh-f2a.2 AC-2). Regenerate ONLY
with exactly this command from the repo root (output is byte-identical
across runs):

```bash
uv run python gen_medium_fixture.py \
  > packages/bots/test/fixtures/medium-decisions.jsonl
```

Contexts are organic (four HeuristicPolicy seats over 60 seeded oracle
hands) plus synthetic direct calls for branches organic play cannot reach:
the `consider_slam` >= 8.0 gate (documented unreachable on random deals in
trace_500.py), the 16-card post-slam keep, `give_best_card`, DNULLA keeps,
and joker-suit naming. Every card-list argument is recorded sorted
ascending — Python tie-breaks follow iteration order, and the TS port sorts
its inputs the same way (see `packages/bots/src/medium.ts`).

`medium.spec.ts` asserts the record count and method coverage, so a
regenerated fixture that changes them must update the spec in the same
commit.

## flagged-hands.json

Two hands lifted out of a real game (`74a62326-cc3c-4969-9962-9d6a57d1a796`,
human seat 0 against three Hard bots) whose play a human flagged through the
in-game debug panel (fh-q2m). `hardPlay.spec.ts` replays each hand from its
deal through the engine, stops on the flagged decision, and asserts the bot
no longer makes the flagged play (fh-4ww).

Copied out of `logs/games/games.jsonl`, which is gitignored and rotates, so
the fixture is the durable record. Each entry keeps only what a replay needs
— `deal`, `firstBidder`, the auction `calls`, `declarer`, `discards`, and
the tricks as `[seat, card]` pairs — plus the human's verbatim `note`. The
`flags` array carries the flagged `{hand, trick, ply}` coordinates, all
0-based, exactly as the debug panel recorded them.

Adding a hand: copy the same fields out of a `games.jsonl` record. Nothing
regenerates this file, and no test asserts its length, so it can grow one
flagged hand at a time.
