# @five-hundred/learn

Self-play tuning and calibration for the Five Hundred bots (epic **fh-sja**).

The first slice (**fh-sja.2**) is the **game-log corpus**: a versioned, faithful,
append-only record of finished games that the later children — the arena
(fh-sja.3), the tuner (fh-sja.4), and the calibration fitters (fh-sja.5) —
consume. This package owns the schema, the recorder, the JSONL writer, and the
validating reader. Nothing here _interprets_ a record; it only captures and
validates.

## Corpus format

A corpus is a **JSONL** file: one `GameRecord` JSON object per line, UTF-8,
newline-terminated, append-only. Read one with:

```ts
import { readGameRecordsSync, validateGameRecord } from '@five-hundred/learn';

const games = readGameRecordsSync('logs/games/games.jsonl'); // throws GameRecordError on any bad line
```

Cards are engine card ids (integers `0..44`, `44` = joker). Bids are the engine
`Bid` object verbatim (`{ kind, level, strain }`). Both are already plain JSON,
so a record is a lossless structural clone — no stringified card names.

## Schema (`v` = `SCHEMA_VERSION`)

Every record carries a `v` field equal to `SCHEMA_VERSION` (currently **1**).
The reader **rejects any record whose `v` it does not understand**, so a
breaking change bumps the constant and the readers that must migrate.

### `GameRecord`

| field         | type                          | notes                                             |
| ------------- | ----------------------------- | ------------------------------------------------- |
| `v`           | `number`                      | schema version; always `SCHEMA_VERSION` on write  |
| `source`      | `'server' \| 'sim'`           | where the game was played                         |
| `gameId`      | `string`                      | unique in a corpus (server: UUID; sim: seed+index)|
| `seed`        | `number`                      | engine RNG seed — deals are reproducible from it  |
| `createdAt`   | `string \| null`              | ISO-8601 finish time, or `null` for headless runs |
| `players`     | `PlayerMeta[]` (length 4)     | seat-indexed provenance                           |
| `hands`       | `HandRecord[]`                | every scored hand, in play order                  |
| `winner`      | `number \| null`              | winning side (`seat % 2`), `null` if undecided    |
| `finalScores` | `[number, number]`            | cumulative points per side (index = `seat % 2`)   |

### `PlayerMeta`

| field                 | type                                       | notes                                              |
| --------------------- | ------------------------------------------ | -------------------------------------------------- |
| `seat`                | `number`                                   | 0..3                                               |
| `kind`                | `'human' \| 'easy' \| 'medium' \| 'hard'`  | how the seat was played (bot tiers = difficulty)   |
| `paramsSchemaVersion` | `number \| null`                           | BotParams version once fh-sja.1 lands; else `null` |
| `overlayHash`         | `string \| null`                           | learned-overlay hash once fh-sja.1 lands; else `null` |

### `HandRecord`

| field         | type                                          | notes                                                        |
| ------------- | --------------------------------------------- | ------------------------------------------------------------ |
| `handNumber`  | `number`                                      | 0-based within the game                                      |
| `dealer`      | `number`                                      | seat that dealt                                              |
| `firstBidder` | `number`                                      | `(dealer + 1) % 4`                                           |
| `redeals`     | `number`                                      | dead auctions thrown in before this hand's contract stood    |
| `deal`        | `{ hands: Card[][]; middle: Card[] }`         | pristine deal (4 × 10 cards + the 5-card middle)             |
| `auction`     | `{ calls; indications; contract; declarer }`  | `calls`/`indications` are `{ seat, bid }[]` in table order   |
| `slam`        | `boolean`                                     | whether a slam was declared                                  |
| `activeSeats` | `number[]`                                     | seats that played the hand (a sat-out partner is absent)     |
| `discards`    | `Card[]`                                       | face-down pile after the exchange                            |
| `tricks`      | `RecordedTrick[]`                              | all tricks: `{ leader, ledSuit, plays: {seat,card}[], winner }` |
| `result`      | `HandOutcome`                                  | inlined engine `HandResult` (deltas + per-side tricks)       |
| `scoresAfter` | `[number, number]`                            | cumulative score after this hand                             |

**Reconstructing per-seat views.** Each seat's play-start hand is
`deal.hands[seat]` plus the middle (declarer) minus `discards`, or equivalently
the union of that seat's cards across `tricks`. The deal, the public auction,
and the full trick sequence make every seat's information state replayable, so
the record does not store post-exchange hands twice.

## Producing a corpus

### Server (opt-in, off by default)

Logging is **disabled unless explicitly enabled**. Set the environment
variables before starting the server:

| variable            | default          | meaning                                   |
| ------------------- | ---------------- | ----------------------------------------- |
| `FH_GAME_LOG`       | _(unset = off)_  | `1`/`true` enables logging                 |
| `FH_GAME_LOG_DIR`   | `logs/games`     | directory for the corpus file             |
| `FH_GAME_LOG_FILE`  | `games.jsonl`    | corpus filename within the directory      |

```bash
FH_GAME_LOG=1 pnpm --filter @five-hundred/server start
# finished games append to logs/games/games.jsonl
```

### Sim (headless self-play)

The bots sim CLI emits the identical schema with `--log`:

```bash
pnpm --filter @five-hundred/bots sim -- --games 200 --policies HMHM --log corpus.jsonl
```

Records are appended (`source: "sim"`, `createdAt: null`, `gameId` = seed+index).

## Calibration (fh-sja.5)

`fitCalibration(records, opts?)` fits two learned artifacts from a corpus with
plain counting-and-shrinkage — no ML dependency:

1. **Make-probability model** — `P(make | strength estimate, contract strain,
   contract level, seat position)` for numbered contracts, as binned counts
   shrunk toward coarser marginals. Query it with
   `makeProbability(artifact, { strain, level, strength, seatPos })`; it returns
   `null` when even the global tally is below `minSamples`, so a caller keeps
   its hand-tuned behavior on thin data. `deriveParamsOverlay(artifact, opts)`
   turns the calibrated make-rate into a **BotParams overlay** (a bounded
   `bidding.headroom` nudge) the bots' overlay loader deep-merges.

2. **Behavior priors** — the distribution of a seat's hand strength conditional
   on its call (pass / indication / numbered bid), fitted **per policy kind**
   (`human` vs each bot tier). `priorFor(artifact, kind, callKind, strain)`
   returns the histogram + moments (or `null` if thin); `priorLogDensity(prior,
   strength)` scores how typical a candidate hidden hand is. The Hard world
   sampler consumes these via `samplePriorConditionedWorld` (packages/bots),
   which keeps the best of several uniform draws by summed prior log-density —
   extending the fh-zpg rule-based partner-indication conditioning to a learned
   one, and falling back to the plain uniform draw when no prior applies.

The artifact is a versioned plain-JSON object (`v = CALIBRATION_SCHEMA_VERSION`,
records its own strength `weights` and `bucketWidth`). `validateCalibration` /
`parseCalibration` are the loud-fallback gate, mirroring the BotParams overlay
loader. Strength itself is `suitStrength(hand, strain, weights?)` — a faithful
copy of the bots `MediumPolicy.suitStrength` (learn may not depend back on bots).

`runSprt(outcomes, cfg?)` is a Wald sequential probability-ratio test over a
win/loss stream (shared with the arena, fh-sja.3): it decides H0 (`p ≤ p0`) vs
H1 (`p ≥ p1`) as early as the evidence allows, the no-regression gate AC-4 uses.

## API

- `SCHEMA_VERSION`, `GameRecord`, `HandRecord`, `PlayerMeta`, … — the schema types.
- `GameRecorder` — accumulate a game: `recordHand(state)` per scored hand, then
  `finish(state)`.
- `buildHandRecord(state, priorDealsDrawn?)` — a single hand record.
- `serializeGameRecord`, `appendGameRecordSync`, `writeGameRecordsSync` — writing.
- `parseGameRecords`, `readGameRecordsSync`, `validateGameRecord`,
  `GameRecordError` — reading and validation.
- `fitCalibration`, `makeProbability`, `deriveParamsOverlay`, `priorFor`,
  `priorLogDensity`, `validateCalibration`, `parseCalibration`,
  `serializeCalibration`, `CalibrationArtifact` — calibration (fh-sja.5).
- `suitStrength`, `bestStrength`, `strengthBucket`, `DEFAULT_STRENGTH_WEIGHTS` —
  hand-strength estimation.
- `runSprt`, `sprtObserve`, `sprtInit`, `DEFAULT_SPRT` — the SPRT gate.
