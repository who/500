/**
 * Client state store (zustand vanilla — usable from socket callbacks and,
 * via zustand's useStore, from React). Holds the room/game views plus
 * connection status, applies server events under the per-room seq discipline
 * (drop stale, apply monotonic, requestState on gap), and persists
 * {roomCode, seatToken, name} in localStorage so a reload can auto-rejoin.
 *
 * Seq rules (see protocol Envelope): a full gameView resets the baseline —
 * the server stamps requestState replies and reattach resends with the
 * last-consumed seq, so equal-seq events are companions, not stale; only a
 * strictly lower seq is stale. A gap (seq > lastSeq + 1) sends exactly one
 * requestState and drops events until the full view arrives.
 */

import { createStore as createVanillaStore, type StoreApi } from 'zustand/vanilla';
import type {
  ActionRequestEvent,
  ClientCommand,
  Envelope,
  ErrorEvent as ProtocolErrorEvent,
  GameOverEvent,
  HandScoredEvent,
  RoomView,
  SeatGameView,
  StateBearingEvent,
  TrickResolvedEvent,
} from '@five-hundred/protocol';
import {
  connect,
  type ConnectionStatus,
  type GameSocket,
  type WebSocketFactory,
} from './net/socket.ts';

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

export interface StoredSession {
  roomCode: string;
  seatToken: string;
  name: string;
}

export const SESSION_STORAGE_KEY = 'five-hundred.session';

/** The slice of Storage we use; injectable so tests avoid jsdom. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  // localStorage can throw on access in some privacy modes.
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadSession(storage: StorageLike | null): StoredSession | null {
  if (storage === null) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const s = parsed as Record<string, unknown>;
  if (
    typeof s.roomCode !== 'string' ||
    typeof s.seatToken !== 'string' ||
    typeof s.name !== 'string'
  ) {
    return null;
  }
  return { roomCode: s.roomCode, seatToken: s.seatToken, name: s.name };
}

export function saveSession(storage: StorageLike | null, session: StoredSession): void {
  try {
    storage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Quota/privacy failures just mean no auto-rejoin after reload.
  }
}

export function clearSession(storage: StorageLike | null): void {
  try {
    storage?.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Ignore: worst case a stale session lingers and rejoin gets badToken.
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** How long a resolved trick stays frozen on the table (PRD 6.2 trick flow). */
export const TRICK_LINGER_MS = 1500;

export interface ClientState {
  connection: ConnectionStatus;
  roomView: RoomView | null;
  seatView: SeatGameView | null;
  /** Latest actionRequest; cleared when a newer gameView supersedes it. */
  pendingActions: ActionRequestEvent | null;
  lastTrick: TrickResolvedEvent['trick'] | null;
  /**
   * Resolved trick held on display for TRICK_LINGER_MS with its winner
   * highlighted before the table releases to the live view. Views keep
   * applying underneath so the viewer's own next action is never delayed —
   * only the trick display and the hand-end overlay wait on this.
   */
  lingerTrick: TrickResolvedEvent['trick'] | null;
  handResult: Pick<HandScoredEvent, 'result' | 'scores'> | null;
  /** Seats ready for the next hand (handReady events); reset on handScored. */
  readySeats: readonly number[];
  /**
   * Latest dead-auction redeal, detected when a gameView's `redeals` counter
   * increments past the previous view's. `dealer` is the new hand's dealer;
   * `count` keys the toast so back-to-back redeals replace, never queue.
   */
  redealNotice: { readonly dealer: number; readonly count: number } | null;
  /**
   * Latest won contract (fh-8kz), detected when a gameView first carries a
   * contract — the auction just resolved. `declarer` is the winning seat;
   * `count` (the hand number) keys the toast so a new hand replaces it. The
   * announcement text reads the live view, so a slam declared while it is up
   * shows through.
   */
  contractNotice: { readonly declarer: number; readonly count: number } | null;
  gameOver: Pick<GameOverEvent, 'winner' | 'scores'> | null;
  lastError: Pick<ProtocolErrorEvent, 'code' | 'message'> | null;
  seat: number | null;
  token: string | null;
  name: string | null;
  session: StoredSession | null;
  /** True in the tab that lost its seat to a newer connection ("seat opened elsewhere"). */
  seatLost: boolean;
  /** True between sending a token rejoin and its roomState/error outcome. */
  rejoining: boolean;
  /** Baseline for gap detection; null until the first state-bearing event. */
  lastSeq: number | null;
  /** True after sending requestState for a gap, until the full view lands. */
  recovering: boolean;
}

export interface ClientActions {
  applyServerEvent(envelope: Envelope): void;
  /** Socket (re)opened: reset the seq baseline and auto-rejoin if a session is stored. */
  handleSocketOpen(): void;
  setConnection(status: ConnectionStatus): void;
  setName(name: string): void;
  /** Dismiss the last error (screens call this before a fresh attempt). */
  clearError(): void;
  /** Dismiss the redeal toast (auto-called by its timer). */
  clearRedealNotice(): void;
  /** Dismiss the contract-won toast (auto-called by its timer). */
  clearContractNotice(): void;
  /** Forget the stored seat and return to the home flow. */
  leaveSession(): void;
}

export type ClientStore = StoreApi<ClientState & ClientActions>;

export interface StoreDeps {
  send(command: ClientCommand): void;
  /** null = no persistence; undefined = use localStorage when available. */
  storage?: StorageLike | null;
}

const HOME_RESET: Partial<ClientState> = {
  session: null,
  token: null,
  seat: null,
  roomView: null,
  seatView: null,
  pendingActions: null,
  lingerTrick: null,
  redealNotice: null,
  contractNotice: null,
  rejoining: false,
  seatLost: false,
};

export function createStore(deps: StoreDeps): ClientStore {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const session = loadSession(storage);

  return createVanillaStore<ClientState & ClientActions>((set, get) => {
    // Trick-linger machinery: the timer handle and the queue of tricks that
    // resolved while another was still frozen (test-mode botgames can finish
    // a whole trick inside the window; each still gets its full linger).
    let lingerTimer: ReturnType<typeof setTimeout> | null = null;
    let lingerQueue: TrickResolvedEvent['trick'][] = [];

    function advanceLinger(): void {
      const next = lingerQueue.shift() ?? null;
      lingerTimer = next === null ? null : setTimeout(advanceLinger, TRICK_LINGER_MS);
      set({ lingerTrick: next });
    }

    function cancelLinger(): void {
      if (lingerTimer !== null) clearTimeout(lingerTimer);
      lingerTimer = null;
      lingerQueue = [];
    }

    function applyPrivate(event: ProtocolErrorEvent | { t: 'seatGranted'; seat: number; token: string }): void {
      if (event.t === 'seatGranted') {
        const state = get();
        const roomCode = state.roomView?.roomCode ?? state.session?.roomCode;
        const name = state.name ?? 'Player';
        if (roomCode !== undefined) {
          const next: StoredSession = { roomCode, seatToken: event.token, name };
          saveSession(storage, next);
          set({ seat: event.seat, token: event.token, seatLost: false, session: next });
        } else {
          set({ seat: event.seat, token: event.token, seatLost: false });
        }
        return;
      }
      const patch: Partial<ClientState> = {
        lastError: { code: event.code, message: event.message },
      };
      if (event.code === 'badToken' || (event.code === 'badRoomCode' && get().rejoining)) {
        // Invalid token, or the room vanished (server restart / idle GC)
        // during auto-rejoin: forget the seat and show the home flow. This is
        // an expected, self-healing discard of a stale session, so it lands on
        // a clean Home screen — no error. (A badRoomCode from a code the user
        // typed themselves is not this branch, and still reports.)
        clearSession(storage);
        Object.assign(patch, HOME_RESET, { lastError: null });
      } else if (event.code === 'seatTaken' && get().seat !== null) {
        // Latest attach wins server-side; this tab lost its seat. Suppress
        // auto-rejoin (it would steal the seat back) until a fresh
        // seatGranted clears the flag.
        Object.assign(patch, { seatLost: true, seat: null, token: null, rejoining: false });
      } else {
        patch.rejoining = false;
      }
      set(patch);
    }

    function applyState(event: StateBearingEvent, seq: number): void {
      const { lastSeq, recovering } = get();
      if (lastSeq !== null && seq < lastSeq) return; // stale
      if (event.t === 'gameView') {
        // Full per-seat view: always a fresh baseline (recovery replies and
        // reattach resends arrive stamped with the last-consumed seq).
        const patch: Partial<ClientState> = {
          seatView: event.view,
          seat: event.view.view.seat,
          pendingActions: null,
          lastSeq: seq,
          recovering: false,
        };
        // A redeals increment means the auction just died: raise the toast
        // (replacing any still showing). Resends carry an equal count, and a
        // rematch resets it, so neither re-triggers.
        const prev = get().seatView?.view;
        const next = event.view.view;
        if (prev !== undefined && next.redeals > prev.redeals) {
          patch.redealNotice = { dealer: next.dealer, count: next.redeals };
        }
        // The auction resolving is exactly `contract` going null -> set (the
        // engine fills contract+declarer in the same step it leaves the
        // auction phase). Announce the win, and drop any redeal toast still
        // up from an earlier dead auction so the two never stack.
        if (
          prev !== undefined &&
          prev.contract === null &&
          next.contract !== null &&
          next.declarer !== null
        ) {
          patch.contractNotice = { declarer: next.declarer, count: next.handNumber };
          patch.redealNotice = null;
        }
        // A rebaseline (reconnect resend / gap recovery) wins immediately:
        // whatever trick was frozen belongs to a timeline the viewer left.
        if (lastSeq === null || recovering) {
          cancelLinger();
          patch.lingerTrick = null;
        }
        set(patch);
        return;
      }
      if (lastSeq !== null && seq > lastSeq + 1) {
        if (!recovering) {
          set({ recovering: true });
          deps.send({ t: 'requestState' });
        }
        return; // dropped; the full view will re-baseline
      }
      const patch: Partial<ClientState> = { lastSeq: seq };
      switch (event.t) {
        case 'roomState':
          patch.roomView = event.room;
          patch.rejoining = false;
          break;
        case 'actionRequest':
          patch.pendingActions = event;
          break;
        case 'trickResolved':
          patch.lastTrick = event.trick;
          // Freeze the resolved trick (winner highlighted) for the linger
          // window; tricks resolving inside it queue so none is skipped.
          if (get().lingerTrick === null) {
            patch.lingerTrick = event.trick;
            lingerTimer = setTimeout(advanceLinger, TRICK_LINGER_MS);
          } else {
            lingerQueue.push(event.trick);
          }
          break;
        case 'handScored':
          patch.handResult = { result: event.result, scores: event.scores };
          patch.readySeats = [];
          break;
        case 'handReady':
          patch.readySeats = event.ready;
          break;
        case 'gameOver':
          patch.gameOver = { winner: event.winner, scores: event.scores };
          patch.pendingActions = null;
          break;
      }
      set(patch);
    }

    return {
      connection: 'connecting',
      roomView: null,
      seatView: null,
      pendingActions: null,
      lastTrick: null,
      lingerTrick: null,
      handResult: null,
      readySeats: [],
      redealNotice: null,
      contractNotice: null,
      gameOver: null,
      lastError: null,
      seat: null,
      token: null,
      name: session?.name ?? null,
      session,
      seatLost: false,
      rejoining: false,
      lastSeq: null,
      recovering: false,

      applyServerEvent(envelope: Envelope): void {
        const event = envelope.event;
        if (event.t === 'error' || event.t === 'seatGranted') {
          applyPrivate(event);
          return;
        }
        // State-bearing envelopes always carry seq (guarded on receive).
        if (typeof envelope.seq === 'number') applyState(event, envelope.seq);
      },

      handleSocketOpen(): void {
        // A reconnect abandons any linger: the resend's full view wins.
        cancelLinger();
        set({ connection: 'open', lastSeq: null, recovering: false, lingerTrick: null });
        const { session: stored, seatLost } = get();
        if (stored !== null && !seatLost) {
          set({ rejoining: true });
          deps.send({
            t: 'joinRoom',
            roomCode: stored.roomCode,
            name: stored.name,
            token: stored.seatToken,
          });
        }
      },

      setConnection(status: ConnectionStatus): void {
        set({ connection: status });
      },

      setName(name: string): void {
        set({ name });
      },

      clearError(): void {
        set({ lastError: null });
      },

      clearRedealNotice(): void {
        set({ redealNotice: null });
      },

      clearContractNotice(): void {
        set({ contractNotice: null });
      },

      leaveSession(): void {
        clearSession(storage);
        cancelLinger();
        set({ ...HOME_RESET, lastSeq: null, recovering: false });
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Client glue: socket + store wired together
// ---------------------------------------------------------------------------

export interface GameClientOptions {
  url?: string;
  storage?: StorageLike | null;
  webSocketFactory?: WebSocketFactory;
}

export interface GameClient {
  store: ClientStore;
  send(command: ClientCommand): boolean;
  close(): void;
}

/** App entry point: one store bound to one auto-reconnecting socket. */
export function createGameClient(options: GameClientOptions = {}): GameClient {
  let socket: GameSocket | null = null;
  const store = createStore({
    send: (command) => {
      socket?.send(command);
    },
    storage: options.storage,
  });
  socket = connect({
    url: options.url,
    webSocketFactory: options.webSocketFactory,
    onEnvelope: (envelope) => store.getState().applyServerEvent(envelope),
    onStatus: (status) => {
      if (status === 'open') store.getState().handleSocketOpen();
      else store.getState().setConnection(status);
    },
  });
  const live = socket;
  return {
    store,
    send: (command) => live.send(command),
    close: () => live.close(),
  };
}
