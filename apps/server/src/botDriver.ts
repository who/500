/**
 * Bot turn driver (PRD sections 4.4 "pacing" and 5 "game loop"): after every
 * state advance, if the acting seat is a bot, invoke its policy and apply the
 * result through the same validated path as human commands — never bypassing
 * validation — after a randomized human-pacing delay (uniform 400–1100ms,
 * overridable to 0 in tests). Chained bot turns each get their own delay.
 *
 * Easy/Medium decisions are microsecond-fast and run on the event loop; Hard
 * seats route through the async decide seam to the worker-thread pool
 * (workers/hardPool.ts), so their rollout budget never blocks the loop.
 * A pool failure (worker crashed twice, spawn failure) degrades that one
 * decision to the seat's synchronous Medium fallback with an error log — a
 * weaker move beats a stuck room.
 */

import { EasyPolicy, MediumPolicy, type Policy } from '@five-hundred/bots';
import {
  JOKER,
  legalPlaysFor,
  makeRng,
  mayDoubleNulla,
  toActSeat,
  type Action,
  type ApplyResult,
  type Bid,
  type GameState,
  type Rng,
} from '@five-hundred/engine';
import type { BotDifficulty } from '@five-hundred/protocol';
import type { Room } from './rooms.js';
import { getSharedHardPool, type HardDecider } from './workers/hardPool.js';

/**
 * Pacing window (fh-x25: was 500–1500ms). Every product seat is Hard, and a
 * Hard decision now spends up to DEFAULT_HARD_BUDGET_MS thinking before this
 * delay's timer even matters — so the old window was stacking a fake pause
 * on top of a real one. Trimmed so the total per-move wait lands about where
 * it did before the budget went up, while an Easy/Medium seat (fallbacks,
 * the sim) still reads as considering its move rather than snapping.
 */
export const BOT_DELAY_MIN_MS = 400;
export const BOT_DELAY_MAX_MS = 1100;

/** Production pacing: uniform in [BOT_DELAY_MIN_MS, BOT_DELAY_MAX_MS). */
export function defaultBotDelayMs(): number {
  return BOT_DELAY_MIN_MS + Math.random() * (BOT_DELAY_MAX_MS - BOT_DELAY_MIN_MS);
}

/**
 * In-thread policy per difficulty. Hard maps to Medium here deliberately:
 * real Hard decisions run HardPolicy inside the worker pool, and this
 * synchronous policy is only its degraded fallback when the pool fails.
 * Since fh-gpk every product seat is Hard, so this path is the fallback and
 * the arena/self-play tiers — never what a player faces on a healthy server.
 *
 * Medium seats get the fh-8jf forgetting curve hung off the game seed
 * (fh-8jf.4), matching what the Hard worker does, so a fallback move is made
 * from the same fallible view of the table as the Hard move it replaces
 * rather than from a perfect card count. Easy has no memory of played cards
 * at all — it decides on the current trick only — so there is nothing to
 * forget and it takes the seed only for signature symmetry.
 */
export function policyFor(difficulty: BotDifficulty, seed: number): Policy {
  return difficulty === 'easy' ? new EasyPolicy() : new MediumPolicy().withMemory(seed);
}

/**
 * Per-seat policy kinds for the Hard sampler (fh-azx.5). Humans are marked
 * human; bot seats use their difficulty; empty/unknown seats stay `hard` so
 * we never guess a seat is human.
 */
export function policyKindsForRoom(room: Room): string[] {
  return room.seats.map((s) => {
    if (s.kind === 'human') return 'human';
    if (s.kind === 'bot') return s.difficulty;
    return 'hard';
  });
}

export interface BotDriverOptions {
  /** Delay before each bot action; defaults to defaultBotDelayMs, 0 in tests. */
  delayMs?: () => number;
  /** Invoked after a fatal driver error; defaults to crashing the room. */
  onFatal?: (room: Room, err: Error) => void;
  /**
   * Worker pool for Hard seats: omit for the shared process-wide pool
   * (created lazily on the first Hard decision), null to force the
   * synchronous Medium fallback (headless-style tests), or inject a fake.
   */
  hardPool?: HardDecider | null;
}

/**
 * A rejected bot action is a server bug (the driver only submits actions its
 * policies derived from the current state), so rather than loop we crash the
 * room: close every client with a typed error and zero lastActivity so the
 * next GC sweep deletes it.
 */
function crashRoom(room: Room): void {
  for (const client of room.clients) {
    client.send({
      event: { t: 'error', code: 'badCommand', message: 'Internal bot error; room closed.' },
    });
    client.room = null;
    client.seat = null;
    client.close();
  }
  room.clients.clear();
  room.lastActivity = 0;
}

interface BotSeat {
  readonly policy: Policy;
  readonly rng: Rng;
  readonly difficulty: BotDifficulty;
}

export class BotDriver {
  private readonly bots = new Map<number, BotSeat>();
  private readonly delayMs: () => number;
  private readonly onFatal: (room: Room, err: Error) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** undefined = resolve the shared pool lazily; null = pool disabled. */
  private hardPool: HardDecider | null | undefined;
  /** Hard decisions issued so far; with the game seed it seeds each rollout. */
  private hardDecisions = 0;

  constructor(
    private readonly room: Room,
    /** The live session; `state` is re-read when each timer fires. */
    private readonly session: { readonly seed: number; state: GameState },
    /** The same validated apply path human commands go through. */
    private readonly apply: (action: Action) => ApplyResult,
    opts: BotDriverOptions = {},
  ) {
    this.delayMs = opts.delayMs ?? defaultBotDelayMs;
    this.onFatal = opts.onFatal ?? crashRoom;
    this.hardPool = opts.hardPool;
    // Bot seats are fixed at game start (empty seats have already been
    // converted); seat-to-bot conversion mid-game arrives through addBot.
    // Per-bot Rng is seeded from game seed + seat for reproducibility.
    room.seats.forEach((s, seat) => {
      if (s.kind === 'bot') {
        this.bots.set(seat, {
          policy: policyFor(s.difficulty, session.seed),
          rng: makeRng((session.seed + seat) >>> 0),
          difficulty: s.difficulty,
        });
      }
    });
  }

  /**
   * Called after every state advance (and once at game start): if the acting
   * seat is a bot, (re)schedule its decision after a fresh pacing delay.
   * handScored needs nothing here — bots are auto-ready and game.ts advances
   * when the humans have all readied.
   */
  onAdvance(): void {
    if (this.disposed) return;
    this.clearTimer();
    const state = this.session.state;
    const seat = toActSeat(state);
    if (seat === null || !this.bots.has(seat)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.act(seat, state);
    }, this.delayMs());
  }

  /**
   * Seat-to-bot conversion (reconnect leaf): register a policy for a seat
   * that started the game as a human, then check whether it already holds
   * the turn — if so, onAdvance schedules its first decision.
   */
  addBot(seat: number, difficulty: BotDifficulty): void {
    this.bots.set(seat, {
      policy: policyFor(difficulty, this.session.seed),
      rng: makeRng((this.session.seed + seat) >>> 0),
      difficulty,
    });
    this.onAdvance();
  }

  /** Cancel any pending decision; the room is going away. */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  /**
   * Decision seam: Hard seats go to the worker pool with a per-decision seed
   * (game seed + running decision count, so a game's Hard stream is
   * reproducible from its seed); everything else — and any pool failure —
   * resolves synchronously in-thread.
   */
  decide(seat: number, state: GameState): Promise<Action> {
    const bot = this.bots.get(seat);
    if (bot !== undefined && bot.difficulty === 'hard') {
      const pool = this.resolveHardPool();
      if (pool !== null) {
        const seed = (this.session.seed + this.hardDecisions++) >>> 0;
        // fh-sja.6: opt this room's Hard seats into the learned overlay when
        // its adaptive-bots toggle is on. The pool is the single gate on
        // overlay presence — with no overlay loaded it sends the defaults
        // regardless, so this is a no-op unless learning is actually shipped.
        return pool
          .decide(state, seat, seed, this.room.adaptiveBots, policyKindsForRoom(this.room))
          .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `[bots] hard decision failed for seat ${seat} in room ${this.room.code}: ` +
              `${message}; using the Medium fallback`,
          );
          return this.decideSync(seat, state);
        });
      }
    }
    return Promise.resolve(this.decideSync(seat, state));
  }

  private resolveHardPool(): HardDecider | null {
    if (this.hardPool === undefined) this.hardPool = getSharedHardPool();
    return this.hardPool;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async act(seat: number, expected: GameState): Promise<void> {
    let action: Action;
    try {
      action = await this.decide(seat, expected);
    } catch (err) {
      this.fatal(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    // The state moved (or the room died) while we were deciding: the advance
    // that moved it already rescheduled us, so this decision is stale.
    if (this.disposed || this.session.state !== expected) return;
    const result = this.apply(action);
    if (!result.ok) {
      this.fatal(
        new Error(
          `bot seat ${seat} produced an illegal ${action.type} in ${expected.phase}: ${result.error.message}`,
        ),
      );
    }
    // On success the apply path broadcast the advance and called onAdvance,
    // scheduling the next bot turn with its own delay.
  }

  private fatal(err: Error): void {
    this.dispose();
    console.error(`[bots] room ${this.room.code} crashed: ${err.message}`);
    this.onFatal(this.room, err);
  }

  /** Engine phase -> Policy method. Every acting phase maps to exactly one. */
  private decideSync(seat: number, state: GameState): Action {
    const bot = this.bots.get(seat);
    if (bot === undefined) throw new Error(`seat ${seat} is not a bot`);
    const { policy, rng } = bot;
    const hand = state.hands[seat] ?? [];
    switch (state.phase) {
      case 'auction': {
        const auction = state.auction;
        if (auction === null) throw new Error('auction phase without auction state');
        const mayIndicate = auction.declarer === null && auction.indicated[seat] !== true;
        return {
          type: 'bid',
          seat,
          bid: policy.chooseBid(
            hand,
            auction.ladderPos,
            mayIndicate,
            {
              seat,
              indications: auction.indications,
              scores: state.game.scores,
              mayDoubleNulla: mayDoubleNulla(auction, seat),
            },
            rng,
          ),
        };
      }
      case 'slamDecision':
        return policy.considerSlam(hand, this.contractOf(state), rng)
          ? { type: 'declareSlam', seat }
          : { type: 'declineSlam', seat };
      case 'partnerCard':
        return { type: 'giveCard', seat, card: policy.giveBestCard(hand, this.contractOf(state), rng) };
      case 'middleExchange':
        return { type: 'discardKeeps', seat, keeps: policy.chooseKeeps(hand, this.contractOf(state), rng) };
      case 'play': {
        const play = state.play;
        if (play === null) throw new Error('play phase without play state');
        const contract = this.contractOf(state);
        const card = policy.choosePlay(
          seat,
          hand,
          legalPlaysFor(play, seat),
          play.plays,
          play.trump,
          play.ledSuit,
          contract,
          { declarer: play.declarer, tricks: play.tricks, handNumber: state.handNumber },
          rng,
        );
        if (card === JOKER && play.trump === null && play.ledSuit === null) {
          // Leading the joker with no trump names a suit; the policy sees the
          // hand without the joker itself (Policy.chooseJokerSuit contract).
          const jokerSuit = policy.chooseJokerSuit(
            hand.filter((c) => c !== JOKER),
            contract,
            rng,
          );
          return { type: 'playCard', seat, card, jokerSuit };
        }
        return { type: 'playCard', seat, card };
      }
      default:
        // toActSeat never names a seat in dealing/handScored/gameOver, so a
        // bot can only land here through an engine phase the Policy interface
        // does not cover — a plan gap, not something to improvise around.
        throw new Error(`no Policy method maps to phase ${state.phase}`);
    }
  }

  private contractOf(state: GameState): Bid {
    if (state.contract === null) throw new Error(`no contract in phase ${state.phase}`);
    return state.contract;
  }
}
