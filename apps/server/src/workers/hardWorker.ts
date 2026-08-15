/**
 * Hard-bot worker entry — runs one HardPolicy decision per request, fully
 * synchronously, inside a worker thread so the rollout's budgeted CPU (up to
 * DEFAULT_HARD_BUDGET_MS, hardPool.ts) never touches the server event loop
 * (PRD 4.3/4.4). The state crosses the thread
 * boundary as the engine's versioned JSON serialization; the reply is the
 * plain engine Action, validated by the driver's normal apply path.
 *
 * Each decision builds its policy from the request's budget and a fresh
 * mulberry32 rng from the request's seed, so a decision is reproducible from
 * (state, seat, seed, budget) alone — the worker keeps no state between
 * requests. A rollout that misses its budget is logged here (stderr) as the
 * packet requires, alongside the Medium fallback the play module applies.
 */

import { parentPort } from 'node:worker_threads';
import { deserializeGame, makeRng } from '@five-hundred/engine';
import {
  HardPolicy,
  observationsFromAuction,
  policyAction,
  validateParams,
  type BotParams,
} from '@five-hundred/bots';
import { parseCalibration, type CalibrationArtifact, type PolicyKind } from '@five-hundred/learn';
import type { HardWorkerRequest, HardWorkerResponse } from './hardPool.js';

const port = parentPort;
if (port === null) throw new Error('hardWorker must be launched as a worker thread');

/**
 * Decode the request's learned overlay (fh-sja.6): a validated BotParams when
 * the room opted in and the payload is well-formed, else undefined so
 * HardPolicy uses its DEFAULT_PARAMS. A malformed payload is logged and
 * ignored rather than failing the decision — a shipped-bot move beats none.
 */
function overlayParams(request: HardWorkerRequest): BotParams | undefined {
  if (request.paramsJson === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.paramsJson);
  } catch (err) {
    console.error(`[hard] seat ${request.seat}: unparseable overlay params, using defaults: ${String(err)}`);
    return undefined;
  }
  const result = validateParams(parsed);
  if (!result.ok) {
    console.error(`[hard] seat ${request.seat}: invalid overlay params (${result.error}), using defaults`);
    return undefined;
  }
  return result.params;
}

/**
 * Decode the request's calibration artifact (fh-azx.5). Missing or malformed
 * payloads leave HardPolicy on the uniform sampler rather than failing the
 * decision — a shipped-bot move beats none.
 */
function requestCalibration(request: HardWorkerRequest): CalibrationArtifact | undefined {
  if (request.calibrationJson === undefined) return undefined;
  try {
    return parseCalibration(request.calibrationJson);
  } catch (err) {
    console.error(
      `[hard] seat ${request.seat}: invalid calibration artifact, using uniform worlds: ${String(err)}`,
    );
    return undefined;
  }
}

/** Per-seat kinds; unknown slots are `hard` — never guessed human. */
function requestPolicyKinds(request: HardWorkerRequest): PolicyKind[] {
  const raw = request.policyKinds;
  const out: PolicyKind[] = [];
  for (let i = 0; i < 4; i++) {
    const k = raw?.[i];
    out.push(k === 'human' || k === 'easy' || k === 'medium' || k === 'hard' ? k : 'hard');
  }
  return out;
}

port.on('message', (request: HardWorkerRequest) => {
  let response: HardWorkerResponse;
  try {
    const state = deserializeGame(request.stateJson);
    const policyKinds = requestPolicyKinds(request);
    const calibration = requestCalibration(request);
    const policy = new HardPolicy({
      params: overlayParams(request),
      calibration,
      policyKinds,
      observations: observationsFromAuction(
        state.auction,
        request.seat,
        policyKinds,
        state.activeSeats,
      ),
      // Human-fallible recall for the shipped bot (fh-8jf.4): the seat derives
      // its constraints through the forgetting curve, so an old low card it has
      // dropped goes back into the unseen pool and it plays on as if that card
      // might still be live. The base seed is the GAME seed, not the request
      // seed — the request seed changes every decision, which would re-roll the
      // curve mid-hand and let a forgotten card flicker back. state.seed is
      // constant for the game and memorySeed mixes in the hand and the seat, so
      // one seat's memory is stable within a hand, fresh each hand, and
      // independent of its partner's.
      memory: { seed: state.seed },
      play: {
        deadlineMs: request.budgetMs,
        onDecision: (d) => {
          if (d.fellBack) {
            console.error(
              `[hard] seat ${request.seat}: rollout finished only ${d.worldsDone} worlds ` +
                `in ${Math.round(d.elapsedMs)}ms (budget ${request.budgetMs}ms); ` +
                `using the Medium choice`,
            );
          }
        },
      },
    });
    const action = policyAction(state, request.seat, policy, makeRng(request.seed >>> 0));
    response = { ok: true, action };
  } catch (err) {
    response = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  port.postMessage(response);
});
