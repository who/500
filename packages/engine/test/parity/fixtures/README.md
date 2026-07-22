# Parity fixtures

## trace-stress-s9-200.jsonl

Committed 200-hand oracle trace replayed by `parity.spec.ts` on every
`pnpm test` run (fh-gty.2 AC-1). Regenerate ONLY with exactly this command
from the repo root (output is byte-identical per trace_500.py AC-2):

```bash
uv run python trace_500.py --seed 9 --hands 200 --policies stress \
  > packages/engine/test/parity/fixtures/trace-stress-s9-200.jsonl
```

Seed 9 with the stress policies was chosen for coverage under the one-pass
auction (fh-8i7 re-picked it from the pre-one-pass seed 19): these 200 hands
contain 581 redeals, 84 NULLA and 60 DNULLA contracts, 10 slams, and one
joker led to a no-trump-type trick (a `named_suit` record) — every edge case
called out by the issue packet. `parity.spec.ts` asserts these counts, so a
regenerated fixture that changes them must update the spec in the same
commit.

The full-scale (>= 10,000 hands) gate does not use this fixture; it streams
freshly generated traces through `pnpm --filter @five-hundred/engine parity
<trace.jsonl>`.
