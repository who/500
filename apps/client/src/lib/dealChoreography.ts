/**
 * Client deal + kitty-pickup state machine (fh-8t1). Pure reducer plus a
 * hook so Table can hold the bid panel, grow hands as packets land, and
 * fly the middle after the contract toast without a server dealing phase.
 */

import { useEffect, useReducer, useRef, type Dispatch } from 'react';
import type { Phase, RedactedView } from '@five-hundred/engine';
import {
  CARDS_PER_PLAYER,
  MIDDLE_CARDS,
  type Packet,
  type Recipe,
  dealSeed,
  expandPackets,
  pickRecipe,
} from './dealPattern.ts';

/** Feature-detect matchMedia; missing means "animate" (same as TrickArea). */
export function prefersReducedMotion(): boolean {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export type DealSeq = 'dealing' | 'holding' | 'pickup' | 'done';

export interface DealState {
  readonly key: string;
  readonly seq: DealSeq;
  readonly seed: number;
  readonly recipe: Recipe;
  readonly packets: readonly Packet[];
  readonly landed: readonly [number, number, number, number];
  readonly middleLanded: number;
}

export type DealEvent =
  | { readonly type: 'sync'; readonly key: string; readonly phase: Phase; readonly seed: number; readonly recipe: Recipe; readonly packets: readonly Packet[]; readonly reduced: boolean; readonly middleCount: number }
  | { readonly type: 'land'; readonly packet: Packet }
  | { readonly type: 'dealDone' }
  | { readonly type: 'skip' }
  | { readonly type: 'toastGone'; readonly declarer: number | null; readonly reduced: boolean }
  | { readonly type: 'pickupDone' };

const FULL_HANDS: readonly [number, number, number, number] = [
  CARDS_PER_PLAYER,
  CARDS_PER_PLAYER,
  CARDS_PER_PLAYER,
  CARDS_PER_PLAYER,
];

export function dealKeyOf(view: Pick<RedactedView, 'handNumber' | 'redeals'>): string {
  return `${view.handNumber}:${view.redeals}`;
}

function emptyDeal(key: string, seed: number, recipe: Recipe, packets: readonly Packet[]): DealState {
  return {
    key,
    seq: 'dealing',
    seed,
    recipe,
    packets,
    landed: [0, 0, 0, 0],
    middleLanded: 0,
  };
}

function heldDeal(key: string, seed: number, recipe: Recipe, packets: readonly Packet[]): DealState {
  return {
    key,
    seq: 'holding',
    seed,
    recipe,
    packets,
    landed: FULL_HANDS,
    middleLanded: MIDDLE_CARDS,
  };
}

function doneDeal(key: string, seed: number, recipe: Recipe, packets: readonly Packet[]): DealState {
  return {
    key,
    seq: 'done',
    seed,
    recipe,
    packets,
    landed: FULL_HANDS,
    middleLanded: 0,
  };
}

export function startDeal(
  phase: Phase,
  key: string,
  seed: number,
  recipe: Recipe,
  packets: readonly Packet[],
  reduced: boolean,
): DealState {
  if (phase !== 'auction') return doneDeal(key, seed, recipe, packets);
  return reduced ? heldDeal(key, seed, recipe, packets) : emptyDeal(key, seed, recipe, packets);
}

export function dealReducer(state: DealState, ev: DealEvent): DealState {
  switch (ev.type) {
    case 'sync': {
      if (ev.key !== state.key) {
        return startDeal(ev.phase, ev.key, ev.seed, ev.recipe, ev.packets, ev.reduced);
      }
      if (ev.phase !== 'auction' && state.seq === 'dealing') {
        return { ...state, seq: 'holding', landed: FULL_HANDS, middleLanded: MIDDLE_CARDS };
      }
      if (ev.phase !== 'auction' && state.seq === 'holding' && ev.middleCount === 0) {
        return { ...state, seq: 'done', middleLanded: 0 };
      }
      return state;
    }
    case 'land': {
      if (state.seq !== 'dealing') return state;
      const landed: [number, number, number, number] = [
        state.landed[0],
        state.landed[1],
        state.landed[2],
        state.landed[3],
      ];
      let middle = state.middleLanded;
      if (ev.packet.dest.kind === 'seat') {
        const seat = ev.packet.dest.seat;
        landed[seat] = (landed[seat] ?? 0) + ev.packet.count;
      } else {
        middle += ev.packet.count;
      }
      return { ...state, landed, middleLanded: middle };
    }
    case 'dealDone':
      if (state.seq !== 'dealing') return state;
      return { ...state, seq: 'holding', landed: FULL_HANDS, middleLanded: MIDDLE_CARDS };
    case 'skip':
      if (state.seq === 'dealing') {
        return { ...state, seq: 'holding', landed: FULL_HANDS, middleLanded: MIDDLE_CARDS };
      }
      if (state.seq === 'pickup') return { ...state, seq: 'done', middleLanded: 0 };
      return state;
    case 'toastGone':
      if (state.seq !== 'holding') return state;
      if (ev.declarer === null) return { ...state, seq: 'done', middleLanded: 0 };
      if (ev.reduced) return { ...state, seq: 'done', middleLanded: 0 };
      return { ...state, seq: 'pickup' };
    case 'pickupDone':
      if (state.seq !== 'pickup') return state;
      return { ...state, seq: 'done', middleLanded: 0 };
  }
}

export interface DealChoreography extends DealState {
  readonly showBidUi: boolean;
  readonly showMiddle: boolean;
  readonly holdPostAuction: boolean;
  readonly dispatch: Dispatch<DealEvent>;
  landPacket(packet: Packet): void;
  completeDeal(): void;
  completePickup(): void;
  skip(): void;
}

function seedFor(view: RedactedView): { key: string; seed: number; recipe: Recipe; packets: Packet[] } {
  const key = dealKeyOf(view);
  const seed = dealSeed(view.handNumber, view.redeals, view.dealer);
  const recipe = pickRecipe(seed);
  return { key, seed, recipe, packets: expandPackets(recipe, view.dealer) };
}

export function useDealChoreography(
  view: RedactedView | null,
  hasContractNotice: boolean,
): DealChoreography {
  const [state, dispatch] = useReducer(dealReducer, view, (v) => {
    if (v === null) return startDeal('play', '', 0, pickRecipe(0), [], prefersReducedMotion());
    const d = seedFor(v);
    return startDeal(v.phase, d.key, d.seed, d.recipe, d.packets, prefersReducedMotion());
  });

  const key = view === null ? '' : dealKeyOf(view);
  const phase = view?.phase ?? 'play';
  const middleCount = view?.middleCount ?? 0;
  const dealer = view?.dealer ?? 0;
  const declarer = view?.declarer ?? null;

  useEffect(() => {
    if (view === null) return;
    const d = seedFor(view);
    dispatch({
      type: 'sync',
      key: d.key,
      phase: view.phase,
      seed: d.seed,
      recipe: d.recipe,
      packets: d.packets,
      reduced: prefersReducedMotion(),
      middleCount: view.middleCount,
    });
  }, [key, phase, middleCount, dealer, view]);

  const prevNotice = useRef(hasContractNotice);
  useEffect(() => {
    if (prevNotice.current && !hasContractNotice) {
      dispatch({ type: 'toastGone', declarer, reduced: prefersReducedMotion() });
    }
    prevNotice.current = hasContractNotice;
  }, [hasContractNotice, declarer]);

  const bidding = phase === 'auction';
  return {
    ...state,
    showBidUi: bidding && state.seq !== 'dealing',
    showMiddle: state.middleLanded > 0 && state.seq !== 'pickup' && state.seq !== 'done',
    holdPostAuction: !bidding && (state.seq === 'dealing' || state.seq === 'holding' || state.seq === 'pickup'),
    dispatch,
    landPacket(packet) {
      dispatch({ type: 'land', packet });
    },
    completeDeal() {
      dispatch({ type: 'dealDone' });
    },
    completePickup() {
      dispatch({ type: 'pickupDone' });
    },
    skip() {
      dispatch({ type: 'skip' });
    },
  };
}
