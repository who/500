# 500

Five Hundred — card game engine, bots, and web UI monorepo.

## End-to-end smoke test

```bash
pnpm e2e
```

One command, no external services: builds every package, boots the built
server (which serves the built client), and drives a real headless Chromium
through a full scripted hand — create room, seat one human plus three Easy
bots, pass through the auction, play legal cards to the hand-end overlay —
asserting the seeded contract and zero browser console errors.

Determinism comes from `TEST_SEED`, an env var the server honors only when
set: it fixes the game seed and removes bot pacing delays. The pinned seed
and the contract it produces live in `e2e/seed.ts`; if engine or bot changes
shift the seeded decision stream, the contract assertion fails loudly —
rerun `e2e/pick-seed.ts` (instructions in its header) to pick a new seed.

First run may need the Playwright browser: `pnpm exec playwright install chromium`.

## Learning bots (self-play tuning)

The Hard bot's strategy constants live in a versioned `BotParams` object
(`packages/bots/params/default.json`, the checked-in source of truth). A
self-play tuner searches those constants and, only when a candidate clears an
SPRT promotion gate, writes a **learned overlay** that the server loads for
Hard seats. Easy and Medium are never touched — the tuner searches only the
`hardBidding.*` group, and the server applies the overlay exclusively to Hard
seats (a tier-stability guard test pins both, byte-for-byte).

### How it applies

- **When an overlay is present** (`packages/bots/params/local.json`, git-ignored):
  the server loads it at startup, the lobby shows a small **`learned vX`** tag,
  and each room defaults to using it for Hard seats. A host can flip the
  **Adaptive bots** toggle to run the checked-in defaults instead. Easy/Medium
  play is identical either way.
- **When no overlay is present**: everything is inert — no tag, no toggle, and
  Hard seats run `default.json` exactly as before. The load is loud-on-failure,
  so a corrupt overlay falls back to defaults with a warning rather than
  breaking the server.

### Logging games and running the tuner

Set `GAME_LOG_DIR` (see `apps/server`) to append versioned JSONL game records
the calibrator reads. To search and (maybe) promote an overlay:

```bash
pnpm learn:tune                                 # tune Hard, default budget
pnpm learn:tune -- --generations 20 --population 32 --eval-games 40
pnpm learn:tune -- --game-budget 200000         # overnight, budget-capped
pnpm learn:tune -- --state run.tuner-state.json # resume a killed run
```

The run is a pure function of `--seed` and reports the shipped-vs-tuned diffs
and win-rate trajectory. It writes `params/local.json` — stamped with a
deterministic `version` tag (the lobby's `learned vX`) — **only** if the best
candidate beats the incumbent and does not regress against the frozen anchor
under a fresh SPRT confirmation match. Otherwise the run is report-only.
Restart the server to pick up a newly written overlay.
