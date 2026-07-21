/**
 * Bot turn driver (PRD sections 4.4 "pacing" and 5 "game loop"): after every
 * state advance, if the acting seat is a bot, invoke its policy and apply the
 * result through the same validated path as human commands — never bypassing
 * validation — after a randomized human-pacing delay (uniform 500–1500ms,
 * overridable to 0 in tests). Chained bot turns each get their own delay.
 *
 * Easy/Medium decisions are microsecond-fast and run on the event loop; the
 * async `decide` seam exists so the M7 worker-pool leaf can swap in an
 * off-thread implementation for Hard seats without touching the loop.
 */

import { EasyPolicy, MediumPolicy, type Policy } from '@five-hundred/bots';
import {
  JOKER,
  legalPlaysFor,
  makeRng,
  toActSeat,
  type Action,
  type ApplyResult,
  type Bid,
  type GameState,
  type Rng,
} from '@five-hundred/engine';
import type { BotDifficulty } from '@five-hundred/protocol';
import type { Room } from './rooms.js';

export const BOT_DELAY_MIN_MS = 500;
export const BOT_DELAY_MAX_MS = 1500;

/** Production pacing: uniform in [BOT_DELAY_MIN_MS, BOT_DELAY_MAX_MS). */
export function defaultBotDelayMs(): number {
  return BOT_DELAY_MIN_MS + Math.random() * (BOT_DELAY_MAX_MS - BOT_DELAY_MIN_MS);
}

/** Hard plays as Medium until the M7 worker-pool leaf swaps the decide seam. */
export function policyFor(difficulty: BotDifficulty): Policy {
  return difficulty === 'easy' ? new EasyPolicy() : new MediumPolicy();
}

export interface BotDriverOptions {
  /** Delay before each bot action; defaults to defaultBotDelayMs, 0 in tests. */
  delayMs?: () => number;
  /** Invoked after a fatal driver error; defaults to crashing the room. */
  onFatal?: (room: Room, err: Error) => void;
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
}

export class BotDriver {
  private readonly bots = new Map<number, BotSeat>();
  private readonly delayMs: () => number;
  private readonly onFatal: (room: Room, err: Error) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

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
    // Seat difficulties are frozen at game start (empty seats have already
    // been converted to bots); per-bot Rng is seeded from game seed + seat
    // for reproducibility.
    room.seats.forEach((s, seat) => {
      if (s.kind === 'bot') {
        this.bots.set(seat, {
          policy: policyFor(s.difficulty),
          rng: makeRng((session.seed + seat) >>> 0),
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

  /** Cancel any pending decision; the room is going away. */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  /**
   * Decision seam: resolve the seat's policy against the state. Async only so
   * M7 can override it with a worker-pool implementation for Hard seats.
   */
  decide(seat: number, state: GameState): Promise<Action> {
    return Promise.resolve(this.decideSync(seat, state));
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
        return { type: 'bid', seat, bid: policy.chooseBid(hand, auction.ladderPos, mayIndicate, rng) };
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
