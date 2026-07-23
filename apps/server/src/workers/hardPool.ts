/**
 * Hard-bot worker pool (PRD 4.3 "time budget" / 4.4 "no event-loop work") —
 * a fixed set of worker_threads running HardPolicy decisions off the main
 * thread. The bot driver's async decide seam posts {serialized state, seat,
 * seed} here for Hard seats; Easy/Medium (and the headless sim) keep the
 * synchronous in-thread path.
 *
 * Sizing: max(1, cpus - 1) capped at 4 (packet decision). Jobs queue FIFO,
 * so simultaneous Hard decisions from many rooms share the pool without
 * starvation. Recovery: a worker that dies mid-decision is respawned and the
 * decision retried once on the fresh worker; a second death rejects it, and
 * the driver falls back to a Medium decision with an error log. A worker
 * that *answers* with an error (a deterministic policy failure) rejects
 * immediately — retrying a deterministic failure would just fail again.
 *
 * Idle workers are unref'd so the pool never keeps the process alive; a
 * worker is ref'd only while a decision is in flight.
 *
 * The worker entry: in production the esbuild build emits
 * dist/workers/hardWorker.js next to the bundle. Running from TypeScript
 * sources (dev server, vitest) there is no prebuilt JS and plain Node cannot
 * load the .js-suffixed TS module graph, so the pool bundles the worker once
 * per process with esbuild (a devDependency; the import is dynamic and the
 * production bundle marks it external, so it never ships).
 */

import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { serializeGame, type Action, type GameState } from '@five-hundred/engine';
import { overlayJson as defaultOverlayJson } from '../botParams.js';

export const HARD_POOL_MAX_WORKERS = 4;
/**
 * Per-decision rollout deadline for a Hard seat (fh-x25: was 1000ms).
 * The budget is a cutoff, not a target — a play rollout that runs out of
 * time keeps only the worlds it finished and falls back to the Medium
 * choice, logged by the worker. 1600ms lets a full 20-world rollout land on
 * the crowded turns where 1000ms was cutting it short, so the seat plays its
 * own judgement more often. It costs wait: with three Hard seats a full
 * round of play is three pacing delays plus three rollouts, which is why the
 * pacing window was trimmed alongside it (botDriver.ts) and why the acting
 * seat now wears the ActivityCard ring — a wait you can see is a wait that
 * reads as deliberate.
 */
export const DEFAULT_HARD_BUDGET_MS = 1600;
/** PRD section 9 risk fallback ceiling: never think longer than 2s. */
export const MAX_HARD_BUDGET_MS = 2000;
export const MIN_HARD_BUDGET_MS = 50;

/** Pool size: leave a core for the event loop, cap at 4 (packet decision). */
export function hardPoolSize(cpuCount: number = cpus().length): number {
  return Math.min(HARD_POOL_MAX_WORKERS, Math.max(1, cpuCount - 1));
}

/** Per-decision budget: HARD_BOT_BUDGET_MS, clamped into [50, 2000]. */
export function hardBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HARD_BOT_BUDGET_MS;
  if (raw === undefined || raw === '') return DEFAULT_HARD_BUDGET_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms)) {
    console.warn(`[hard] ignoring non-numeric HARD_BOT_BUDGET_MS="${raw}"`);
    return DEFAULT_HARD_BUDGET_MS;
  }
  return Math.min(MAX_HARD_BUDGET_MS, Math.max(MIN_HARD_BUDGET_MS, ms));
}

export interface HardWorkerRequest {
  readonly stateJson: string;
  readonly seat: number;
  readonly seed: number;
  readonly budgetMs: number;
  /**
   * Serialized learned BotParams (fh-sja.6). Present only when the deciding
   * room opted into the adaptive overlay; the worker validates it and falls
   * back to DEFAULT_PARAMS if it is absent or malformed.
   */
  readonly paramsJson?: string;
}

export type HardWorkerResponse =
  | { readonly ok: true; readonly action: Action }
  | { readonly ok: false; readonly error: string };

/** What the bot driver needs from a pool; tests substitute fakes. */
export interface HardDecider {
  /**
   * `useOverlay` (fh-sja.6): when true and a learned overlay is loaded, the
   * decision runs HardPolicy under the overlay params; otherwise it runs the
   * checked-in defaults. Optional so existing callers/fakes need no change.
   */
  decide(state: GameState, seat: number, seed: number, useOverlay?: boolean): Promise<Action>;
}

const IS_SOURCE = import.meta.url.endsWith('.ts');

let entryPromise: Promise<URL> | null = null;

/**
 * Resolve (building if necessary) the worker's entry module. Cached per
 * process: every pool shares one bundle, rebuilt fresh on process start so
 * dev/test never runs a stale worker.
 */
function workerEntry(): Promise<URL> {
  entryPromise ??= (async (): Promise<URL> => {
    if (!IS_SOURCE) return new URL('./workers/hardWorker.js', import.meta.url);
    const source = fileURLToPath(new URL('./hardWorker.ts', import.meta.url));
    const outfile = join(
      dirname(source),
      '..',
      '..',
      'node_modules',
      '.cache',
      'hardWorker.bundle.mjs',
    );
    const { build } = await import('esbuild');
    await build({
      entryPoints: [source],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      outfile,
      logLevel: 'silent',
    });
    return pathToFileURL(outfile);
  })();
  return entryPromise;
}

interface Job {
  readonly request: HardWorkerRequest;
  readonly resolve: (action: Action) => void;
  readonly reject: (err: Error) => void;
  retried: boolean;
}

export class HardBotPool implements HardDecider {
  private readonly queue: Job[] = [];
  private readonly workers = new Set<Worker>();
  private readonly idle: Worker[] = [];
  private readonly running = new Map<Worker, Job>();
  private readonly init: Promise<void>;
  private entry: URL | null = null;
  private initError: Error | null = null;
  private disposed = false;

  constructor(
    private readonly size: number = hardPoolSize(),
    private readonly budgetMs: number = hardBudgetMs(),
    /** Serialized learned overlay for opted-in rooms; null disables it. */
    private readonly overlayJson: string | null = defaultOverlayJson,
  ) {
    this.init = workerEntry().then(
      (url) => {
        if (this.disposed) return;
        this.entry = url;
        for (let i = 0; i < this.size; i++) this.spawn();
        this.pump();
      },
      (err: unknown) => {
        this.initError = err instanceof Error ? err : new Error(String(err));
        for (const job of this.queue.splice(0)) job.reject(this.initError);
      },
    );
  }

  /** Resolved once the workers are spawned (or spawning failed). */
  whenReady(): Promise<void> {
    return this.init;
  }

  get workerCount(): number {
    return this.workers.size;
  }

  decide(state: GameState, seat: number, seed: number, useOverlay = false): Promise<Action> {
    if (this.disposed) return Promise.reject(new Error('hard bot pool is disposed'));
    if (this.initError !== null) return Promise.reject(this.initError);
    const paramsJson = useOverlay ? (this.overlayJson ?? undefined) : undefined;
    return new Promise<Action>((resolve, reject) => {
      this.queue.push({
        request: { stateJson: serializeGame(state), seat, seed, budgetMs: this.budgetMs, paramsJson },
        resolve,
        reject,
        retried: false,
      });
      this.pump();
    });
  }

  /** Reject everything in flight and terminate every worker. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const err = new Error('hard bot pool disposed');
    for (const job of this.queue.splice(0)) job.reject(err);
    for (const job of this.running.values()) job.reject(err);
    this.running.clear();
    const workers = [...this.workers];
    this.workers.clear();
    this.idle.length = 0;
    await Promise.all(workers.map((w) => w.terminate()));
  }

  /** Test seam: hard-kill every worker as if it crashed mid-decision. */
  async crashWorkers(): Promise<void> {
    await Promise.all([...this.workers].map((w) => w.terminate()));
  }

  private spawn(): void {
    if (this.entry === null) throw new Error('spawn before worker entry resolved');
    const worker = new Worker(this.entry);
    this.workers.add(worker);
    worker.unref(); // idle workers must not keep the process alive
    worker.on('message', (msg: HardWorkerResponse) => this.finish(worker, msg));
    worker.on('error', (err) => this.died(worker, err));
    worker.on('exit', (code) => {
      // Normal teardown removes the worker from the set first; anything else
      // still registered here died unexpectedly (crash, terminate, exit()).
      if (this.workers.has(worker)) {
        this.died(worker, new Error(`hard worker exited with code ${code}`));
      }
    });
    this.idle.push(worker);
  }

  private finish(worker: Worker, msg: HardWorkerResponse): void {
    const job = this.running.get(worker);
    this.running.delete(worker);
    worker.unref();
    this.idle.push(worker);
    if (job !== undefined) {
      if (msg.ok) job.resolve(msg.action);
      else job.reject(new Error(msg.error));
    }
    this.pump();
  }

  private died(worker: Worker, err: Error): void {
    if (!this.workers.delete(worker)) return; // already handled
    const i = this.idle.indexOf(worker);
    if (i >= 0) this.idle.splice(i, 1);
    const job = this.running.get(worker);
    this.running.delete(worker);
    void worker.terminate(); // no-op if already gone; belt and braces
    if (this.disposed) return;
    this.spawn(); // keep the pool at strength
    if (job !== undefined) {
      if (job.retried) {
        job.reject(err);
      } else {
        job.retried = true;
        this.queue.unshift(job); // retry ahead of newer work
      }
    }
    this.pump();
  }

  private pump(): void {
    while (!this.disposed && this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop() as Worker;
      const job = this.queue.shift() as Job;
      this.running.set(worker, job);
      worker.ref(); // a decision in flight keeps the process alive
      worker.postMessage(job.request);
    }
  }
}

let shared: HardBotPool | null = null;

/**
 * Process-wide pool, created on the first Hard decision so servers without
 * Hard seats never spawn a thread.
 */
export function getSharedHardPool(): HardBotPool {
  shared ??= new HardBotPool();
  return shared;
}
