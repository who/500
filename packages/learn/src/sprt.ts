/**
 * Wald's Sequential Probability Ratio Test for a Bernoulli win-rate (fh-sja.5,
 * shared with the arena fh-sja.3). Given a stream of win/loss outcomes it
 * decides, as early as the evidence allows, between H0 (win-rate <= p0) and H1
 * (win-rate >= p1) at type-I/type-II error rates alpha/beta — the promotion
 * gate the calibration no-regression check (AC-4) and the param arena both
 * want. Pure and incremental: fold one outcome at a time, stop the moment the
 * log-likelihood ratio crosses a boundary.
 *
 * The classic Bernoulli SPRT: for each observation x in {0,1},
 *   llr += x * ln(p1/p0) + (1-x) * ln((1-p1)/(1-p0))
 * accept H1 when llr >= ln((1-beta)/alpha), accept H0 when llr <= ln(beta/(1-alpha)).
 */

export interface SprtConfig {
  /** Null-hypothesis win-rate ceiling (H0: p <= p0). */
  readonly p0: number;
  /** Alternative-hypothesis win-rate floor (H1: p >= p1). Must exceed p0. */
  readonly p1: number;
  /** Type-I error (reject H0 when true). */
  readonly alpha: number;
  /** Type-II error (accept H0 when H1 true). */
  readonly beta: number;
}

/** H1 = "better" accepted, H0 = "not better" accepted, continue = undecided. */
export type SprtVerdict = 'accept-h1' | 'accept-h0' | 'continue';

export interface SprtState {
  /** Cumulative log-likelihood ratio. */
  readonly llr: number;
  readonly wins: number;
  readonly losses: number;
  readonly verdict: SprtVerdict;
}

export const DEFAULT_SPRT: SprtConfig = Object.freeze({
  p0: 0.5,
  p1: 0.55,
  alpha: 0.05,
  beta: 0.05,
});

function upper(cfg: SprtConfig): number {
  return Math.log((1 - cfg.beta) / cfg.alpha);
}
function lower(cfg: SprtConfig): number {
  return Math.log(cfg.beta / (1 - cfg.alpha));
}

/** The fresh, undecided state. */
export function sprtInit(): SprtState {
  return { llr: 0, wins: 0, losses: 0, verdict: 'continue' };
}

function verdictFor(llr: number, cfg: SprtConfig): SprtVerdict {
  if (llr >= upper(cfg)) return 'accept-h1';
  if (llr <= lower(cfg)) return 'accept-h0';
  return 'continue';
}

/**
 * Fold one Bernoulli outcome into the running test. Once a verdict is reached
 * the state is returned unchanged (the test has stopped); callers check
 * `verdict !== 'continue'` to break their sampling loop early. Draws (ties)
 * carry no information and are passed as `null` — they advance neither counter.
 */
export function sprtObserve(
  state: SprtState,
  win: boolean | null,
  cfg: SprtConfig = DEFAULT_SPRT,
): SprtState {
  if (state.verdict !== 'continue') return state;
  if (win === null) return state;
  const { p0, p1 } = cfg;
  const delta = win
    ? Math.log(p1 / p0)
    : Math.log((1 - p1) / (1 - p0));
  const llr = state.llr + delta;
  return {
    llr,
    wins: state.wins + (win ? 1 : 0),
    losses: state.losses + (win ? 0 : 1),
    verdict: verdictFor(llr, cfg),
  };
}

export interface SprtResult extends SprtState {
  /** wins / (wins + losses); 0.5 when no decisive games were seen. */
  readonly winRate: number;
  /** Decisive games observed (draws excluded). */
  readonly decisiveGames: number;
}

/**
 * Run the test over a finite outcome stream (true = win, false = loss, null =
 * draw), stopping early on a verdict. When the stream ends undecided the
 * verdict stays `continue` — the caller decides whether an inconclusive result
 * is a pass (no-regression checks treat "not significantly worse" as a pass).
 */
export function runSprt(
  outcomes: Iterable<boolean | null>,
  cfg: SprtConfig = DEFAULT_SPRT,
): SprtResult {
  let state = sprtInit();
  for (const o of outcomes) {
    state = sprtObserve(state, o, cfg);
    if (state.verdict !== 'continue') break;
  }
  const decisiveGames = state.wins + state.losses;
  return {
    ...state,
    decisiveGames,
    winRate: decisiveGames > 0 ? state.wins / decisiveGames : 0.5,
  };
}
