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
