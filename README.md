# 500

Five Hundred is a four-player partnership trick-taking game. Each deal gives
everyone ten cards and leaves five in the middle (the kitty). Players bid
once around for the right to name trumps; the winning side then tries to take
the tricks they promised. First partnership to 500 points wins; a side that
reaches −500 is out the back.

This repository is **one specific breed** of 500: it implements the house
rules in [`500-house-rules.md`](500-house-rules.md), not a generic
tournament book. The distinctive bits include a **single round of four
calls** (dealer last), **6-level indications** that never win the auction,
a **minimum contract of 7**, **nulla / double nulla**, and a **declared
slam that is always ±500**. If you learned 500 at a different table, those
details will differ.

The goal is to let people play **this** 500 over the internet — same
scoring, same auction, same kitty — against friends or against bots. The
bots are part of that: they sit empty seats, they can learn from finished
human games (the play-log calibrator), and they can get harder over time
when a learned overlay clears the promotion gate. Easy and Medium stay
frozen so the table has a stable floor; only Hard takes the overlay.

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

### Strategy parameters (`BotParams`)

Every number the bots use for “how good is this hand?” and “should I bid /
slam / keep this card?” lives in `packages/bots/params/default.json`. An
**overlay** is a small JSON patch on top of that file (only the keys that
changed). The server deep-merges the overlay into Hard seats only.

Two different searches write overlays, and they touch **different keys**:

| Pipeline | What it changes | What it does *not* change |
|---|---|---|
| `learn:calibrate` | `bidding.headroom` only (a bounded nudge, at most ±1) | Hard rollout knobs, memory, Easy/Medium |
| `learn:tune` (CEM) | `hardBidding.bidMargin`, `slamMargin`, `nullaCandLowness`, `dnullaCandLowness` | Shared Medium thresholds, world counts |

If a night of calibrate prints `bidding.headroom 4 -> 4.17` and then
`NOT PROMOTED`, the fit ran; the confirmation match just could not prove
the new Hard was better. The corpus is still in the store.

#### Learning terms, plainly

None of this is a neural net. It is counting, a small search, and a
statistical gate.

| Term | What it means here |
|---|---|
| **Overlay** | A JSON patch of a few numbers, merged over `default.json`. Same idea as a config diff, not a new model. |
| **Make-rate** | Among numbered contracts in the corpus, the fraction that actually made. Target is 50%. Over-safe play (make-rate high) → raise `bidding.headroom` so Hard bids one extra level; over-reaching → lower it. |
| **Calibration** | Count make/set by strain, level, hand strength, and seat; shrink thin buckets toward coarser totals so a rare 10NT does not swing the numbers. Also builds **priors**: “hands that pass / indicate / bid this suit usually look like *this*.” Hard uses those priors when it imagines hidden hands. |
| **minSamples** | Floor of 30 numbered hands. Below that, calibrate logs `skipped: thin corpus` and writes nothing. Nulla, redeals, and unfinished games do not count. |
| **World / rollout** | Hard does not “know” the other hands. It deals many legal hidden hands (worlds), plays the rest of the deal in its head, and averages the score. More worlds = slower, less noisy. |
| **CEM** (cross-entropy method) | `learn:tune` only. Sample a population of Hard bidding knobs, play them against the incumbent, keep the winners, recenter the search. Repeat for *N* generations. |
| **SPRT** | Sequential test on win/loss. Default: is the candidate’s win-rate at least 55%, versus “it’s just 50/50”? Promote only on a clear **yes** (`accept-h1`). Budget exhausted with no decision (`continue`) or a **no** (`accept-h0`) → not promoted. Mirror matches (swap seats) double the games per seed, which is why `--confirm-games 80` can report 160 games. |
| **Incumbent / anchor** | Incumbent = Hard as loaded today (defaults + current overlay). Anchor = frozen `default.json`. A promote must beat the incumbent *and* not lose to the anchor, so a lucky overlay cannot walk Hard downhill. |

#### `suitStrength.*` — how many tricks a suit is worth

Used when Medium (and Hard’s first cut) estimates a hand. Units are
roughly “expected tricks.” Defaults:

| Key | Default | Meaning |
|---|---:|---|
| `joker` | 1.0 | Joker is one sure trick. |
| `bower` | 0.95 | Right or left bower. |
| `trumpHonor` | 0.55 | Trump queen or better (bowers already counted). |
| `trumpLow` | 0.35 | Smaller natural trump. |
| `sideAce` | 0.75 | Off-trump ace. |
| `sideKing` | 0.25 | Off-trump king. |
| `ntAce` | 0.9 | Ace in no-trump. |
| `ntKing` | 0.5 | King in no-trump. |
| `ntQueen` | 0.2 | Queen in no-trump. |

#### `bidding.*` — when to bid, indicate, or go nulla

`maxLevel ≈ min(10, floor(strengthEstimate + headroom))`. Raising
`headroom` makes the bot willing to name a higher contract.

| Key | Default | Meaning |
|---|---:|---|
| `headroom` | 4.0 | Extra levels above the raw strength estimate. Calibrate nudges this toward a 50% make-rate (max ±1). Higher = more aggressive numbered bids. |
| `indicateEst` | 4.5 | Minimum estimate to fire a 6-level indication, and the strength that indication promises partner. |
| `partnerIndicationBonus` | 2.0 | Extra support credited when partner has indicated. |
| `nullaLowness` | 8.6 | How “low” the hand must look before Medium considers Nulla. |
| `nullaMaxRank` | 11 | Highest card allowed in a Nulla try (11 = jack). |

#### `slam.*` and `endgame.*`

| Key | Default | Meaning |
|---|---:|---|
| `slam.est` | 8.0 | Suit-strength at or above which the declarer declares slam after the middle. |
| `endgame.cheapestContract` | 140 | Points for 7♠ — the cheapest winning bid. Used as a scale, not bid as such. |
| `endgame.headroom` | 1.5 | Extra bid headroom when the opponents can win the *game* by taking this auction. |
| `endgame.desperateHeadroom` | 2.5 | Still more headroom when four defender tricks would also finish the game. |
| `endgame.desperateScore` | 460 | Opponent score at which those four defender tricks (40 points) reach 500. |

#### `hardBidding.*` — Hard’s auction search (what `learn:tune` actually moves)

Hard samples hidden worlds, plays out the rest of the deal, and only bids
if the average score beats passing by `bidMargin` points.

| Key | Default | Meaning |
|---|---:|---|
| `rolloutWorlds` | 16 | Hidden hands sampled per bid/slam decision. Compute budget; not tuned. |
| `bidMargin` | 10 | Extra expected points over “pass” required to bid. Lower = more willing to bid. **Tuned.** |
| `slamMargin` | 25 | Extra expected points of slamming vs not. Lower = more slams. **Tuned.** |
| `nullaCandLowness` | 8.0 | Looser Nulla gate than Medium, so Hard will even *consider* Nulla. **Tuned.** |
| `nullaCandMaxRank` | 12 | Highest rank still allowed in a Nulla candidate (12 = queen). |
| `dnullaCandLowness` | 8.6 | Same idea for double Nulla. **Tuned.** |
| `dnullaCandMaxRank` | 11 | Highest rank for a double-Nulla candidate (11 = jack). |
| `indWorldTries` | 20 | How many times Hard retries a random world so it matches partner’s indication. |

#### `hardKeeps.*` — what to keep from the middle

| Key | Default | Meaning |
|---|---:|---|
| `keepWorlds` | 30 | Worlds per keep/discard decision. |
| `marginalKeeps` | 3 | Borderline kept cards Hard is allowed to swap out. |
| `nearMarginalDiscards` | 4 | Borderline discarded cards it may swap back in. |
| `maxCandidates` | 12 | Cap on keep-sets it scores (base set plus those swaps). |

#### `hardPlay.*` — which card to play

| Key | Default | Meaning |
|---|---:|---|
| `worldsFloor` | 20 | Fewest playouts a card-play average may rest on. |
| `worldsCap` | 200 | Most playouts in a hard, high-stakes spot. |
| `trickWeight` | 8 | Extra reward per own-side trick (flipped on Nulla). Small enough that it cannot prefer a set with more tricks over a make. |
| `mediumTiebreakEps` | 5 | If Hard’s best card beats Medium’s pick by fewer than this many points, play Medium’s card. |
| `mediumTiebreakZ` | 2 | Same idea, but in standard errors of the rollout noise. Stops Hard from “improving” on a coin flip. |

#### `hardMemory.*` — what Hard is allowed to forget

Not a neural memory. Each seen card gets a **salience** (how memorable)
and a **horizon** in tricks. After that many tricks, the observation can
drop so Hard no longer counts the card as known. Shipped values were
calibrated so about 14% of played spot cards fade, while jokers/bowers
never do.

| Key | Default | Meaning |
|---|---:|---|
| `jokerSalience` | 1.0 | Joker is the most memorable card. |
| `bowerSalience` | 0.95 | Right or left bower, in trump. |
| `aceSalience` | 0.8 | Any ace. |
| `kingSalience` | 0.6 | Any king. |
| `queenSalience` | 0.45 | Any queen. |
| `jackSalience` | 0.35 | A jack that is not a bower. |
| `spotSalience` | 0.1 | A 4 — easiest card to forget. |
| `spotRankStep` | 0.02 | Added per rank above 4, so a 10 sticks a bit more than a 5. |
| `trumpBonus` | 0.6 | Extra salience if the card counts as trump. |
| `permanentSalience` | 0.7 | At or above this, the card is kept for the whole hand. |
| `baseHorizon` | 2.0 | Tricks a zero-salience card is remembered. |
| `salienceHorizon` | 12.0 | Extra tricks of memory per unit of salience. |
| `jitter` | 0.35 | Random spread on that horizon (0 = none). |
| `graceTricks` | 1 | The immediately previous trick is never forgotten. |
| `voidHorizon` | 12.0 | How long an observed void is remembered. |
| `voidDecay` | 0.34 | How much of that void horizon the distant past may lose. |
