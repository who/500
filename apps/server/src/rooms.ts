/**
 * In-memory room lifecycle (PRD section 5 "Rooms" / "Ops"): room codes, seat
 * claiming with per-seat secret tokens, host-only bot configuration and game
 * start, and the 2h-idle GC sweep. Transport-agnostic: handlers operate on
 * the RoomClient interface so tests can drive the store without sockets;
 * ws.ts adapts real WebSockets onto it.
 *
 * Game-command handling is the next leaf — startGame only stubs the game
 * object via an injectable hook.
 */

import { randomUUID } from 'node:crypto';
import type {
  BotDifficulty,
  BotSeatConfig,
  Envelope,
  ErrorCode,
  RoomSeatView,
  RoomView,
  StateBearingEvent,
} from '@five-hundred/protocol';

/** One connection's transport surface plus its room bindings. */
export interface RoomClient {
  send(envelope: Envelope): void;
  close(): void;
  room: Room | null;
  /** Claimed seat index, null while spectating from the lobby. */
  seat: number | null;
  name: string | null;
}

export type SeatState =
  | { kind: 'human'; name: string; token: string; connected: boolean }
  /** difficulty = what the bot will play at if the seat is still empty at start */
  | { kind: 'empty'; difficulty: BotDifficulty }
  | { kind: 'bot'; difficulty: BotDifficulty };

export interface Room {
  code: string;
  seats: [SeatState, SeatState, SeatState, SeatState];
  /** First joiner; transfers to the next human if they leave pre-game. */
  host: RoomClient | null;
  /** Stub until the game-loop leaf; non-null means the game has started. */
  game: unknown;
  seq: number;
  lastActivity: number;
  clients: Set<RoomClient>;
}

export const DEFAULT_DIFFICULTY: BotDifficulty = 'medium';
export const ROOM_CODE_LENGTH = 5;
/** A–Z + 2–9 minus O/I/0/1 lookalikes. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const IDLE_ROOM_MS = 2 * 60 * 60 * 1000;
export const GC_INTERVAL_MS = 5 * 60 * 1000;
const MAX_CLIENTS_PER_ROOM = 4;

function emptySeat(): SeatState {
  return { kind: 'empty', difficulty: DEFAULT_DIFFICULTY };
}

function seatView(seat: number, s: SeatState): RoomSeatView {
  if (s.kind === 'human') {
    return { seat, occupant: 'human', name: s.name, difficulty: null, connected: s.connected };
  }
  return { seat, occupant: s.kind, name: null, difficulty: s.difficulty, connected: true };
}

export function roomView(room: Room): RoomView {
  return {
    roomCode: room.code,
    hostSeat: room.host?.seat ?? null,
    seats: room.seats.map((s, i) => seatView(i, s)),
    started: room.game !== null,
  };
}

export class RoomStore {
  readonly rooms = new Map<string, Room>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly opts: {
      random?: () => number;
      /** Game-loop leaf plugs in here; the default stubs the game object. */
      startGame?: (room: Room) => unknown;
    } = {},
  ) {}

  generateRoomCode(): string {
    const random = this.opts.random ?? Math.random;
    for (;;) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
  }

  /** Send a private (non-seq) event to one client. */
  private sendError(client: RoomClient, code: ErrorCode, message: string): void {
    client.send({ event: { t: 'error', code, message } });
  }

  /** Stamp the next per-room seq and deliver to every connected client. */
  broadcast(room: Room, event: StateBearingEvent): void {
    const envelope: Envelope = { seq: room.seq++, event };
    for (const client of room.clients) client.send(envelope);
  }

  private broadcastRoomState(room: Room): void {
    this.broadcast(room, { t: 'roomState', room: roomView(room) });
  }

  private touch(room: Room): void {
    room.lastActivity = Date.now();
  }

  createRoom(client: RoomClient, name: string): Room | null {
    if (client.room !== null) {
      this.sendError(client, 'badCommand', 'Already in a room.');
      return null;
    }
    const room: Room = {
      code: this.generateRoomCode(),
      seats: [emptySeat(), emptySeat(), emptySeat(), emptySeat()],
      host: client,
      game: null,
      seq: 0,
      lastActivity: Date.now(),
      clients: new Set([client]),
    };
    this.rooms.set(room.code, room);
    client.room = room;
    client.name = name;
    this.broadcastRoomState(room);
    return room;
  }

  joinRoom(client: RoomClient, roomCode: string, name: string): void {
    if (client.room !== null) {
      this.sendError(client, 'badCommand', 'Already in a room.');
      return;
    }
    const room = this.rooms.get(roomCode.toUpperCase());
    if (room === undefined) {
      this.sendError(client, 'badRoomCode', `No room with code ${roomCode}.`);
      return;
    }
    if (room.game !== null) {
      // Token-based rejoin of a running game is the reconnect leaf.
      this.sendError(client, 'badCommand', 'Game already started.');
      return;
    }
    if (room.clients.size >= MAX_CLIENTS_PER_ROOM) {
      this.sendError(client, 'badCommand', 'Room is full.');
      return;
    }
    room.clients.add(client);
    client.room = room;
    client.name = name;
    this.touch(room);
    this.broadcastRoomState(room);
  }

  sit(client: RoomClient, seat: number): void {
    const room = client.room;
    if (room === null) {
      this.sendError(client, 'badCommand', 'Not in a room.');
      return;
    }
    if (room.game !== null) {
      this.sendError(client, 'badCommand', 'Game already started.');
      return;
    }
    const target = room.seats[seat];
    if (target === undefined) {
      this.sendError(client, 'badCommand', `No such seat ${seat}.`);
      return;
    }
    if (target.kind !== 'empty') {
      this.sendError(client, 'seatTaken', `Seat ${seat} is taken.`);
      return;
    }
    if (client.seat !== null) room.seats[client.seat] = emptySeat();
    const token = randomUUID();
    room.seats[seat] = {
      kind: 'human',
      name: client.name ?? 'Player',
      token,
      connected: true,
    };
    client.seat = seat;
    this.touch(room);
    client.send({ event: { t: 'seatGranted', seat, token } });
    this.broadcastRoomState(room);
  }

  configureBots(client: RoomClient, bots: readonly BotSeatConfig[]): void {
    const room = client.room;
    if (room === null) {
      this.sendError(client, 'badCommand', 'Not in a room.');
      return;
    }
    if (client !== room.host) {
      this.sendError(client, 'notHost', 'Only the host can configure bots.');
      return;
    }
    if (room.game !== null) {
      this.sendError(client, 'badCommand', 'Game already started.');
      return;
    }
    const occupied = bots.find((b) => room.seats[b.seat]?.kind === 'human');
    if (occupied !== undefined) {
      this.sendError(client, 'seatTaken', `Seat ${occupied.seat} is held by a human.`);
      return;
    }
    for (const b of bots) {
      const s = room.seats[b.seat];
      if (s !== undefined && s.kind !== 'human') s.difficulty = b.difficulty;
    }
    this.touch(room);
    this.broadcastRoomState(room);
  }

  startGame(client: RoomClient): void {
    const room = client.room;
    if (room === null) {
      this.sendError(client, 'badCommand', 'Not in a room.');
      return;
    }
    if (client !== room.host) {
      this.sendError(client, 'notHost', 'Only the host can start the game.');
      return;
    }
    if (room.game !== null) {
      this.sendError(client, 'badCommand', 'Game already started.');
      return;
    }
    if (!room.seats.some((s) => s.kind === 'human')) {
      this.sendError(client, 'badCommand', 'At least one human must be seated to start.');
      return;
    }
    room.seats.forEach((s, i) => {
      if (s.kind === 'empty') room.seats[i] = { kind: 'bot', difficulty: s.difficulty };
    });
    room.game = this.opts.startGame?.(room) ?? { stub: true };
    this.touch(room);
    this.broadcastRoomState(room);
  }

  /** Socket closed: vacate pre-game, mark disconnected mid-game, move host. */
  handleDisconnect(client: RoomClient): void {
    const room = client.room;
    if (room === null) return;
    room.clients.delete(client);
    client.room = null;
    if (client.seat !== null) {
      const s = room.seats[client.seat];
      if (room.game === null) {
        room.seats[client.seat] = emptySeat();
      } else if (s?.kind === 'human') {
        s.connected = false; // game pauses for them (PRD); reconnect leaf resumes
      }
      client.seat = null;
    }
    if (room.host === client && room.game === null) {
      room.host = this.nextHost(room);
    }
    if (room.clients.size > 0) this.broadcastRoomState(room);
    // An emptied room lingers until the idle GC reclaims it.
  }

  private nextHost(room: Room): RoomClient | null {
    let fallback: RoomClient | null = null;
    for (const c of room.clients) {
      if (c.seat !== null) return c; // prefer a seated human
      fallback ??= c;
    }
    return fallback;
  }

  /** Delete rooms idle >= IDLE_ROOM_MS, closing their sockets with a typed error. */
  sweep(now: number = Date.now()): void {
    for (const room of this.rooms.values()) {
      if (now - room.lastActivity < IDLE_ROOM_MS) continue;
      this.rooms.delete(room.code);
      for (const client of room.clients) {
        client.send({
          event: { t: 'error', code: 'badRoomCode', message: 'Room expired after 2h idle.' },
        });
        client.room = null;
        client.seat = null;
        client.close();
      }
      room.clients.clear();
    }
  }

  startGc(): void {
    if (this.gcTimer !== null) return;
    this.gcTimer = setInterval(() => this.sweep(), GC_INTERVAL_MS);
    this.gcTimer.unref?.();
  }

  stopGc(): void {
    if (this.gcTimer !== null) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }
}
