/**
 * WebSocket client wrapper: connects to the game server, auto-reconnects with
 * exponential backoff (capped at 5s — battery-friendly on mobile), sends typed
 * ClientCommands as JSON, and dispatches only guard-validated Envelopes to the
 * caller. Transport only: seq bookkeeping and state live in store.ts.
 */

import { isEnvelope, type ClientCommand, type Envelope } from '@five-hundred/protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * The slice of the browser WebSocket this module touches, so tests can inject
 * a hand-rolled mock without jsdom or a real server.
 */
export interface SocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => SocketLike;

const SOCKET_OPEN = 1;

export const BASE_BACKOFF_MS = 250;
export const MAX_BACKOFF_MS = 5000;

/** Exponential backoff: base * 2^attempt, capped. */
export function backoffDelay(
  attempt: number,
  base: number = BASE_BACKOFF_MS,
  max: number = MAX_BACKOFF_MS,
): number {
  return Math.min(max, base * 2 ** attempt);
}

/**
 * Server URL: VITE_SERVER_URL when set (dev points at ws://localhost:8500),
 * otherwise same-origin derived from location (prod serves ws and assets from
 * one host).
 */
export function resolveServerUrl(
  env?: Record<string, unknown>,
  loc?: { protocol: string; host: string },
): string {
  const e = env ?? (import.meta as unknown as { env?: Record<string, unknown> }).env;
  const override = e?.VITE_SERVER_URL;
  if (typeof override === 'string' && override.length > 0) return override;
  const l = loc ?? (typeof location === 'undefined' ? undefined : location);
  if (l === undefined) {
    throw new Error('No location to derive the server URL from; set VITE_SERVER_URL.');
  }
  return `${l.protocol === 'https:' ? 'wss' : 'ws'}://${l.host}`;
}

export interface GameSocketOptions {
  url?: string;
  onEnvelope?: (envelope: Envelope) => void;
  onStatus?: (status: ConnectionStatus) => void;
  webSocketFactory?: WebSocketFactory;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface GameSocket {
  /** Serialize and send; false (dropped) unless the socket is open. */
  send(command: ClientCommand): boolean;
  /** Stop reconnecting and close for good. */
  close(): void;
  status(): ConnectionStatus;
}

export function connect(options: GameSocketOptions = {}): GameSocket {
  const factory: WebSocketFactory =
    options.webSocketFactory ?? ((url) => new WebSocket(url) as SocketLike);
  const url = options.url ?? resolveServerUrl();
  const base = options.baseBackoffMs ?? BASE_BACKOFF_MS;
  const max = options.maxBackoffMs ?? MAX_BACKOFF_MS;

  let socket: SocketLike | null = null;
  let status: ConnectionStatus = 'connecting';
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let closedByUser = false;

  function setStatus(next: ConnectionStatus): void {
    if (status === next) return;
    status = next;
    options.onStatus?.(next);
  }

  function handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (isEnvelope(parsed)) options.onEnvelope?.(parsed);
  }

  function open(): void {
    const s = factory(url);
    socket = s;
    s.onopen = () => {
      if (closedByUser || s !== socket) return;
      attempt = 0;
      setStatus('open');
    };
    s.onmessage = (ev) => {
      if (s === socket) handleMessage(ev.data);
    };
    // Browsers always follow error with close; reconnect logic lives there.
    s.onerror = () => {};
    s.onclose = () => {
      if (s !== socket) return;
      socket = null;
      if (closedByUser) {
        setStatus('closed');
        return;
      }
      setStatus('reconnecting');
      const delay = backoffDelay(attempt, base, max);
      attempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        open();
      }, delay);
    };
  }

  open();

  return {
    send(command: ClientCommand): boolean {
      if (socket === null || socket.readyState !== SOCKET_OPEN) return false;
      socket.send(JSON.stringify(command));
      return true;
    },
    close(): void {
      closedByUser = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const s = socket;
      socket = null;
      s?.close(1000, 'client closed');
      setStatus('closed');
    },
    status: () => status,
  };
}
