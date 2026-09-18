# PRD: 500 (House Rules) — Web UI with Bots

**Status:** Draft for decomposition via `ortus plan`
**Date:** 2026-07-20
**Project type:** Personal project (family card game)
**Reference implementations:** `five_hundred.py` (rules engine + policies, treated as the rules oracle), `500-house-rules.md` (canonical ruleset)

---

## 1. Overview

Build a browser-based version of our family's house-rules 500 card game. 1–4 humans play in a shared game room; bots fill any empty seats. There is one bot — Hard, the determinized-rollout player — and no difficulty picker: every seat the server fills plays it. The existing Python engine is ported to TypeScript and becomes the single runtime engine; the Python code remains as a cross-validation oracle for the port.

### Goals

- Playable, correct implementation of the full house ruleset in the browser.
- 1–4 human players per game via join-by-code rooms; bots auto-fill remaining seats.
- One bot, strong enough that a good human table has to play well to beat it.
- Runs locally with one command; game state is in-memory (no accounts, no database).
- The TypeScript engine is provably faithful to the Python engine (parity test suite).

### Non-Goals

- No internet deployment, accounts, matchmaking, or persistence across server restarts.
- No mobile-native apps (responsive web is enough).
- No chat, spectators, or game replays in v1.
- No configurable rule variants — the house rules are the only rules.
- No animations beyond basic card movement polish; correctness and clarity first.

---

## 2. Architecture

All-TypeScript monorepo. Rationale: the user chose to port the engine to TS; multiplayer requires a sync point, so a thin Node server hosts rooms and serves the client. One language end-to-end, engine shared by server (authoritative) and client (types + display logic).

```
500/
  packages/
    engine/     # pure TS rules engine — zero runtime deps, deterministic, seeded RNG
    bots/       # Hard policy + its internal heuristic play-out model (depends on engine)
    protocol/   # shared message & state-view types (client/server contract)
  apps/
    server/     # Node + ws: room management, authoritative game loop, serves client build
    client/     # Vite + React SPA: lobby, table UI, hand controls
  five_hundred.py        # kept as parity oracle (not shipped)
  500-house-rules.md     # canonical rules
```

- **Server-authoritative.** The server owns game state and runs the engine; clients receive per-seat **redacted views** (a player never receives other players' hands, the middle, or discards). All human inputs are validated server-side against `legalPlays`/ladder rules.
- **Transport:** WebSocket, JSON messages. Reconnect supported via room code + per-seat token stored in `localStorage` (browser refresh mid-game resumes the seat).
- **In-memory rooms.** A `Map<roomCode, Room>`; rooms are garbage-collected after inactivity. Server restart loses games — acceptable per scope.
- **Bots run in the server process.** Hard-bot rollouts execute in a `worker_threads` pool so they never block the event loop.
- **Determinism:** engine accepts an injected seeded RNG (port the `random.Random` usage pattern); given the same seed and inputs, TS and Python engines must produce identical deals and legal outcomes (see §7 parity).

**Tooling defaults** (override only with reason): pnpm workspaces, TypeScript strict mode, Vitest for tests, Vite for the client, ESLint + Prettier. Single dev command (e.g. `pnpm dev`) starts server + client; single prod command (`pnpm start`) serves the built client from the Node server.

---

## 3. Engine Port (packages/engine)

Port `five_hundred.py` faithfully. The house rules in `500-house-rules.md` are canonical; the Python code resolves any ambiguity. Key elements, restated so issues can be cut against them:

### 3.1 Cards & deck
- 45 cards: ranks 4–A in four suits (2s/3s removed) + one joker.
- Card encoding may differ from Python's `suit*11 + (rank-4)` ints, but a bijective mapping to the Python encoding must exist for parity tests.
- Deal: 10 cards per player, 5-card middle (kitty).

### 3.2 Bid ladder
- 6-level bids are non-winning **indications** (one per player per auction, only before a winning bid exists; they keep the auction alive).
- Minimum winning bid: 7. Avondale values: `40 + strain*20 + (level-6)*100` (7♠=140 … 10NT=520).
- Suit order low→high: ♠ ♣ ♦ ♥ NT.
- **Nulla (250):** above all 7-bids, below all 8-bids. Solo — declarer's partner sits out.
- **Double Nulla (500):** above 10♦, below 10♥ and 10NT. Played 2-v-2.
- Redeal if no winning bid is ever made (all pass / only indications).
- Auction ends when 3 consecutive non-bids follow a winning bid (matching Python's `consecutive_quiet` logic).

### 3.3 Middle exchange
- Winning bidder picks up the middle (15 cards), keeps 10, discards 5 face-down.
- **Double nulla:** declarer keeps 10 and passes their 5 discards to partner; partner picks up (15), keeps 10, discards 5.
- **Slam** (numbered bids only): while holding the 15, declarer may declare a slam — partner surrenders their single best card (partner chooses), declarer keeps 10 from 16, partner sits out, declarer must take all 10 tricks. Made: bid value + 250. Failed: −(bid value + 250).

### 3.4 Trick play
- Declarer leads trick 1; trick winner leads next.
- Must follow the led (effective) suit if able.
- **Trump hands:** joker is highest trump; right bower (J of trump), left bower (J of same color, counts as trump suit for following) are next.
- **NT / nulla / double nulla:** joker counts as *every* suit — while held, its owner can always follow, so they may never sluff; played (not led) it silently assumes the led suit; only when **led** does its holder name a suit.

### 3.5 Scoring
- Made numbered bid: +bid value. Set: −bid value. Defenders: 10/trick taken.
- Nulla / double nulla: ±250 / ±500; defenders get 10 per trick forced onto the bidding side.
- Game: first side to +500 wins; −500 loses ("out the back"). Both-cross tiebreak: declarer side checked first (matches Python).

### 3.6 Engine API shape
- Pure, synchronous state machine: `GameState + Action -> GameState` (or an equivalent class), with explicit phases: `dealing → auction → middleExchange (→ slamDecision → partnerCard) → trick play → handScore → gameOver | next deal`.
- Exposes: `legalActions(state, seat)`, per-seat `redactedView(state, seat)`, and serializable state (JSON) for the server and tests.
- No `Date.now`/`Math.random` inside the engine — RNG injected.

---

## 4. Bots (packages/bots)

Hard and the heuristic model it rolls out through implement one `Policy` interface mirroring the Python one: `chooseBid`, `chooseKeeps`, `considerSlam`, `giveBestCard`, `chooseJokerSuit`, `choosePlay`. Only Hard is offered as a seat: `BOT_DIFFICULTIES` in `packages/protocol/src/views.ts` is a one-element tuple, so `hard` is the only difficulty the wire accepts.

### 4.1 History — the retired Easy and Medium tiers
Kept so old commits, milestone rows, and bead history stay legible; **not a requirement**. This PRD originally specified three selectable tiers. Easy was a port of `RandomPolicy` with guardrails (timid random bidding, uniform-random legal play, never nulla or slam), aimed at a child or first-time player. Medium was a faithful port of `HeuristicPolicy`, and the lobby carried a per-seat selector between the three. Easy was deleted and Medium stopped being a seat you can sit at: the product ships Hard alone, and the heuristic survives only inside it (§4.2).

### 4.2 The internal heuristic play-out model
`HeuristicPolicy` (`packages/bots/src/heuristic.ts`) is no longer a bot a player can face — it is the fast table-sense policy Hard plays its imagined worlds out with, and the card Hard falls back to when its budget runs out before the rollout is worth trusting. Its behavior is unchanged from the Python original: suit-strength bid estimation, nulla detection on uniformly low hands, void-building discards, cheapest-winner / duck-in-lose-all play, joker led into shortest suit, slams via the `est >= 8.0` threshold. It must stay cheap enough to run thousands of times per decision, and it is the yardstick Hard's strength is measured against (§7.3).

### 4.3 Hard — "Determinized rollouts"
Monte Carlo over hidden information, extending the approach in the Python `evaluate_keeps`:
- **World sampling:** deal unseen cards uniformly at random to hidden seats, consistent with observed constraints (voids revealed by failure to follow suit must be respected in play-phase sampling).
- **Discard/keep decisions:** generate candidate keep-sets heuristically (the heuristic model's discarder + variations), evaluate each over N sampled worlds with heuristic seats playing out, pick the best (direct port + improvement of `evaluate_keeps`).
- **Bidding:** estimate make-probability of candidate contracts by rollout; bid up the ladder while EV(bid) > EV(pass) with a safety margin. Also evaluates nulla/double-nulla/slam by rollout.
- **Card play:** at each decision, roll out each legal card over M sampled worlds (the heuristic model for all players' continuations), pick the highest-EV card.
- **Compute budget:** each decision ≤ ~1s wall-clock on a laptop; N/M tuned to meet that (expect ~50–200 worlds). Runs in a worker thread; the UI shows a "thinking" indicator.
- **Acceptance:** in headless simulation, a Hard partnership must win ≥ 60% of games over 200+ games against a partnership playing the internal heuristic model, from either side of the table.

### 4.4 Bot infrastructure
- Headless simulation harness in TS (port of `simulate_hands` / `simulate_games` / `print_stats`) used for the strength acceptance tests and tuning.
- No difficulty selection: every bot seat plays Hard, so there is nothing per-seat to configure. Seat views still carry a `difficulty` field as the wire's seat-kind tag, always `hard` for bot seats.
- Human-pacing delay: bots act with a short randomized delay (~0.5–1.5s) so play is followable; delay is skipped in headless mode.

---

## 5. Server (apps/server)

- **Rooms:** create room → get 4–6 char code; join by code; host picks their seat, others pick from free seats; host starts game (every empty seat becomes a Hard bot).
- **Session/reconnect:** per-seat secret token issued on join; rejoining with the token reclaims the seat and current redacted view. If a human disconnects mid-game, the game pauses for them (bots don't take over in v1); host may convert an abandoned seat to a bot.
- **Message protocol (packages/protocol):** typed client→server commands (`createRoom`, `joinRoom`, `sit`, `configureBots`, `startGame`, `bid`, `discardKeeps`, `declareSlam`, `giveCard`, `playCard`, `chooseJokerSuit`, `nextHand`) and server→client events (`roomState`, `gameView`, `actionRequest`, `trickResolved`, `handScored`, `gameOver`, `error`). Every state-bearing message carries a monotonically increasing sequence number so clients can detect gaps and request a full view.
- **Validation:** every command validated against `legalActions` for that seat; invalid commands return a typed error and change nothing.
- **Game loop:** server advances the engine; whenever the acting seat is a bot, the server invokes its policy (worker pool for Hard) and applies the result after the pacing delay.
- **Ops:** single process, `PORT` env var (default 5000... use 8500 to avoid the joke writing itself — pick one and document it), graceful room cleanup after 2h idle.

---

## 6. Client (apps/client)

Vite + React + TypeScript SPA. Responsive; usable on a phone but designed for laptop/tablet.

### 6.1 Screens
1. **Home:** create game / join by code; enter display name.
2. **Lobby:** 4 seats around a table graphic; humans claim seats; empty seats say so and fill with AI players on start — no difficulty control; start button (host only).
3. **Table (main game screen):**
   - Your hand fanned at the bottom, sorted by suit with trump/bower grouping once a contract exists (left bower shown with the trump suit); joker distinct.
   - Other seats show card backs + card count, dealer marker, whose-turn highlight, and sat-out state (nulla partner / slam partner shown clearly as "sitting out").
   - Center: current trick (cards placed by seat position), and during the auction, the bidding panel.
   - Persistent HUD: contract + declarer, trick count per side (e.g. "Us 3 – Them 2"), running game score, bid value at stake.
4. **Hand-end overlay:** contract result (made/set), points delta per side, running totals; "next hand" ready-up.
5. **Game-end screen:** winner, final score, "rematch" (same room, same seats/bots).

### 6.2 Phase-specific UI
- **Auction:** bid picker showing only currently legal bids (ladder-aware), grouped: numbered bids by level/strain grid, Nulla, Double Nulla, Indication (6-level, only when legal), Pass. Show full bid history around the table. Explain indication bids with a tooltip ("signal to partner — does not win the auction"). On redeal, an explanatory toast.
- **Middle exchange:** declarer sees 15 cards; selects exactly 5 discards; confirm button disabled until exactly 5. Slam declaration is offered on this same screen for numbered bids ("Declare slam — play alone for all 10 tricks: +{value+250} or −{value+250}") with a confirm step. Double-nulla partner gets the same 15→10 picker when the 5 cards pass through.
- **Slam partner card:** partner picks 1 card to surrender (UI suggests their strongest but lets them choose).
- **Joker lead (NT/nulla):** when leading the joker, a suit picker appears; when merely playing it, no prompt (it follows the led suit silently). While holding the joker in NT/nulla, illegal sluff attempts are blocked with the explanation "you can't sluff while holding the joker."
- **Trick flow:** completed trick lingers ~1.5s with the winner highlighted before clearing; last completed trick is reviewable via a "last trick" peek.
- **Legality:** illegal cards in hand are visually dimmed and unclickable; the reason appears on hover/long-press.

### 6.3 Quality bar
- No rules knowledge should be needed to operate the UI — legal actions are the only ones offered.
- Every state change a player can't see (bot discards, hidden middle) is represented abstractly (e.g. "Bot picked up the middle and discarded 5").
- Light/dark friendly; suits colored (red/black) with high contrast; card faces readable at phone sizes.

---

## 7. Correctness & Testing

1. **Engine unit tests (Vitest):** port every assertion in `_self_test()` plus new cases: ladder ordering (incl. nulla/double-nulla placements), Avondale values, bower following, joker-blocks-sluffing, joker silent-suit-assumption, auction quiet-count endings, redeal, double-nulla pass-through exchange, slam 16→10 flow, scoring for every contract class incl. defender points on lose-all bids, out-the-back and both-cross-500 tiebreak.
2. **Python↔TS parity harness (the port's acceptance gate):**
   - Add a small JSON-lines trace mode to the Python engine (script may live alongside `five_hundred.py`): with seed S, emit deals, auction actions, legal-play sets, trick winners, and hand scores for K hands with both sides using deterministic policies.
   - TS harness replays the same traces: identical deals given the mapped RNG stream is impractical across languages, so instead replay **recorded actions**: feed the Python-recorded deal + actions into the TS engine and assert every intermediate legal-action set, trick winner, and score matches. Target: ≥ 10,000 hands, zero divergence.
3. **Bot strength tests:** headless `simulateGames` runs asserting the Hard-beats-heuristic gate (§4.3) — Hard wins ≥ 60% of seeded games against the internal heuristic model, checked from both sides of the table.
4. **Protocol/integration tests:** simulated multi-client games over real WebSockets — join/reconnect, redacted views never contain hidden cards (assert by inspection of every message), illegal command rejection.
5. **Smoke E2E (Playwright, small):** one scripted full game — create room, 1 human + 3 bots, play a hand to scoring via UI.

---

## 8. Milestones (decomposition guide for ortus)

| # | Epic | Outcome / acceptance |
|---|------|----------------------|
| M0 | Repo scaffold | pnpm monorepo, packages wired, CI-less local `pnpm test`/`pnpm dev` work |
| M1 | Engine port | All §7.1 unit tests pass |
| M2 | Parity harness | Python trace mode + TS replay; 10k hands, zero divergence |
| M3 | Baseline bots + sim harness | Shipped under the retired tiers (§4.1): the random and heuristic policies were ported, the headless sim reproduced sane stats, and the heuristic beat random ≥60%. The heuristic survives as Hard's play-out model |
| M4 | Server + protocol | Rooms, seats, reconnect, validated commands, bot turns; integration tests green |
| M5 | Client — core loop | Full playable game vs bots: auction → exchange → play → scoring → game over |
| M6 | Client — full rules UX | Slam flow, nulla/double-nulla flows, joker UX, indication bids, redeal |
| M7 | Hard bot | Rollout bot within time budget; wins ≥60% over 200 games against the heuristic play-out model (the tier it was measured against when it shipped) |
| M8 | Polish + E2E | Trick animations/pacing, last-trick peek, responsive pass, Playwright smoke test |

Dependency shape: M1→M2→(M3, M4)→M5→M6; M7 depends on M3; M8 last. M4 can start against M1's API before M2 completes.

---

## 9. Risks & mitigations

- **Port drift from Python semantics** → M2 parity gate before UI work builds on the engine; house-rules doc + Python are dual oracles.
- **Hard bot too slow in JS** → worker threads + tunable world counts; fallback acceptance is 0.5–2s/decision; strength test is the gate, not elegance.
- **Auction edge cases (indications, quiet counts, redeal)** are the likeliest divergence spot → dedicated parity traces weighted toward auctions.
- **Multiplayer scope creep** → no accounts, no persistence, no spectators; reconnect token is the only session mechanism.

## 10. Open questions (fine to default during implementation)

- Exact card visual style (SVG drawn vs unicode-suit minimalist) — default: clean SVG faces.
- ~~Whether the weakest tier may ever bid slams/nullas~~ — settled by the tiers retiring (§4.1); Hard evaluates both by rollout.
- Port number and app name shown in the header — default: "Five Hundred", port 8500.
