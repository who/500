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

## Learning bots

The Hard bot's strategy constants live in a versioned `BotParams` object
(`packages/bots/params/default.json`, the checked-in source of truth). Two
pipelines can write a **learned overlay** that the server loads for Hard seats
only. They are not interchangeable:

- **Self-play tuner** (`pnpm learn:tune`) — CEM search over `hardBidding.*`.
  It never reads play logs.
- **Play-log calibrator** (`pnpm learn:calibrate`) — fits a Hard overlay and
  `calibration.json` from a GameRecord corpus (local JSONL or the store).

Easy and Medium stay frozen. Neither pipeline searches those tiers, and the
server applies the overlay exclusively to Hard seats (a tier-stability guard
test pins both, byte-for-byte).

### How it applies

- **When an overlay is present** (`packages/bots/params/local.json`, git-ignored,
  or the store artifacts after a promote): the server loads it at startup, the
  lobby shows a small **`learned vX`** tag, and each room defaults to using it
  for Hard seats. A host can flip the **Adaptive bots** toggle to run the
  checked-in defaults instead. Easy/Medium play is identical either way.
- **When no overlay is present**: everything is inert — no tag, no toggle, and
  Hard seats run `default.json` exactly as before. The load is loud-on-failure,
  so a corrupt overlay falls back to defaults with a warning rather than
  breaking the server.

In production the game service writes finished games into the `fh-play-logs`
bucket. The Railway `learner` service runs `pnpm learn:calibrate -- --store
--upload --confirm-games 80` on cron `0 6 * * *` (06:00 UTC). A promote
uploads the artifacts and bumps `FH_LEARNED_VERSION` so the game service
redeploys and the lobby shows the new `learned vX`. A thin corpus or an SPRT
reject exits 0, writes nothing, and does not redeploy — a silent night is not
a failure.

### Self-play tuner

`pnpm learn:tune` searches Hard constants in self-play. It does not read
server play logs or Railway logs.

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

### Play-log calibrator

Server logging is on by default (`resolveGameLogConfig` in
`apps/server/src/gameLog.ts`). Set `FH_GAME_LOG` to `0` or `false` to opt
out. Optional path overrides: `FH_GAME_LOG_DIR` (default `logs/games`) and
`FH_GAME_LOG_FILE` (default `games.jsonl`). Finished games also upload to the
store when the AWS env is set (`AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET_NAME`, `AWS_DEFAULT_REGION`).

`pnpm learn:calibrate` is the play-log pipeline. Point it at a local JSONL
(no AWS env required) or at the store:

```bash
# local-only: default server corpus, no store credentials
pnpm learn:calibrate -- --in logs/games/games.jsonl

# production-shaped: read the bucket, upload if SPRT promotes
pnpm learn:calibrate -- --store --upload --confirm-games 80
```

`--in` and `--store` can be combined; game ids are deduped. A corpus whose
make-rate sample count is below the fitter's `minSamples` logs `skipped:
thin corpus` and writes nothing. A candidate that fails the SPRT gate is
report-only. Artifacts land in `--out-dir` (default `packages/bots/params`)
only on promote, or immediately under test-only `--skip-sprt`.
