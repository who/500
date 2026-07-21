import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope, RoomView } from '@five-hundred/protocol';
import {
  backoffDelay,
  connect,
  resolveServerUrl,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  type ConnectionStatus,
  type SocketLike,
} from './socket.ts';

/** Hand-rolled WebSocket double: tests drive open/receive/drop explicitly. */
class MockSocket implements SocketLike {
  static instances: MockSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    MockSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }

  // -- test drivers ---------------------------------------------------------

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  }

  /** Unexpected drop (server restart, network loss). */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

function roomViewFixture(): RoomView {
  return {
    roomCode: 'ABCDE',
    hostSeat: null,
    seats: [0, 1, 2, 3].map((seat) => ({
      seat,
      occupant: 'empty' as const,
      name: null,
      difficulty: 'medium' as const,
      connected: true,
    })),
    started: false,
    paused: false,
  };
}

function latest(): MockSocket {
  const sock = MockSocket.instances.at(-1);
  if (sock === undefined) throw new Error('no socket created');
  return sock;
}

describe('resolveServerUrl', () => {
  it('prefers the VITE_SERVER_URL override', () => {
    expect(resolveServerUrl({ VITE_SERVER_URL: 'ws://localhost:8500' })).toBe(
      'ws://localhost:8500',
    );
  });

  it('derives ws from an http origin and wss from https', () => {
    expect(resolveServerUrl({}, { protocol: 'http:', host: 'example.com:5173' })).toBe(
      'ws://example.com:5173',
    );
    expect(resolveServerUrl({}, { protocol: 'https:', host: 'play.example.com' })).toBe(
      'wss://play.example.com',
    );
  });
});

describe('backoffDelay', () => {
  it('doubles from the base and caps at 5s', () => {
    expect(backoffDelay(0)).toBe(BASE_BACKOFF_MS);
    expect(backoffDelay(1)).toBe(BASE_BACKOFF_MS * 2);
    expect(backoffDelay(2)).toBe(BASE_BACKOFF_MS * 4);
    expect(backoffDelay(30)).toBe(MAX_BACKOFF_MS);
  });
});

describe('connect', () => {
  const envelopes: Envelope[] = [];
  const statuses: ConnectionStatus[] = [];

  function connectMock() {
    return connect({
      url: 'ws://test.local',
      webSocketFactory: (url) => new MockSocket(url),
      onEnvelope: (e) => envelopes.push(e),
      onStatus: (s) => statuses.push(s),
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    MockSocket.instances = [];
    envelopes.length = 0;
    statuses.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a socket to the given url and reports open', () => {
    const gs = connectMock();
    expect(latest().url).toBe('ws://test.local');
    expect(gs.status()).toBe('connecting');
    latest().open();
    expect(gs.status()).toBe('open');
    expect(statuses).toEqual(['open']);
  });

  it('sends typed commands as JSON only while open', () => {
    const gs = connectMock();
    expect(gs.send({ t: 'requestState' })).toBe(false); // not open yet
    latest().open();
    expect(gs.send({ t: 'createRoom', name: 'Ana' })).toBe(true);
    expect(latest().sent.map((s) => JSON.parse(s))).toEqual([{ t: 'createRoom', name: 'Ana' }]);
  });

  it('dispatches valid envelopes and ignores junk', () => {
    connectMock();
    latest().open();
    latest().receive('not json at all');
    latest().receive({ seq: 0, event: { t: 'nonsense' } });
    latest().receive({ event: { t: 'roomState', room: roomViewFixture() } }); // missing seq
    const valid: Envelope = { seq: 0, event: { t: 'roomState', room: roomViewFixture() } };
    latest().receive(valid);
    expect(envelopes).toEqual([valid]);
  });

  it('reconnects after a drop with doubling backoff capped at 5s', () => {
    connectMock();
    latest().open();
    latest().drop();
    expect(statuses).toEqual(['open', 'reconnecting']);
    expect(MockSocket.instances).toHaveLength(1);

    // First retry after BASE_BACKOFF_MS.
    vi.advanceTimersByTime(BASE_BACKOFF_MS - 1);
    expect(MockSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockSocket.instances).toHaveLength(2);

    // Failed attempts double the delay: 500, 1000, 2000, 4000, then cap.
    for (const delay of [500, 1000, 2000, 4000]) {
      latest().drop();
      vi.advanceTimersByTime(delay - 1);
      expect(latest().readyState).toBe(3); // no new socket yet
      const count = MockSocket.instances.length;
      vi.advanceTimersByTime(1);
      expect(MockSocket.instances).toHaveLength(count + 1);
    }

    // Past the cap the delay stays at MAX_BACKOFF_MS.
    latest().drop();
    vi.advanceTimersByTime(MAX_BACKOFF_MS - 1);
    const count = MockSocket.instances.length;
    expect(MockSocket.instances).toHaveLength(count);
    vi.advanceTimersByTime(1);
    expect(MockSocket.instances).toHaveLength(count + 1);
  });

  it('resets the backoff after a successful open', () => {
    connectMock();
    latest().open();
    latest().drop();
    vi.advanceTimersByTime(BASE_BACKOFF_MS);
    latest().drop(); // second consecutive failure -> 500ms
    vi.advanceTimersByTime(BASE_BACKOFF_MS * 2);
    latest().open(); // success resets the attempt counter
    latest().drop();
    const count = MockSocket.instances.length;
    vi.advanceTimersByTime(BASE_BACKOFF_MS);
    expect(MockSocket.instances).toHaveLength(count + 1);
  });

  it('close() stops reconnecting for good', () => {
    const gs = connectMock();
    latest().open();
    gs.close();
    expect(gs.status()).toBe('closed');
    expect(latest().closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(MockSocket.instances).toHaveLength(1);
  });

  it('close() during a reconnect wait cancels the retry', () => {
    const gs = connectMock();
    latest().open();
    latest().drop();
    gs.close();
    vi.advanceTimersByTime(60_000);
    expect(MockSocket.instances).toHaveLength(1);
    expect(gs.status()).toBe('closed');
  });
});
