/**
 * WebSocket plumbing: attaches a `ws` WebSocketServer to the HTTP server,
 * adapts each socket onto the transport-agnostic RoomClient interface, and
 * dispatches guarded commands — room lifecycle into the RoomStore, game
 * commands into the authoritative game loop (game.ts). Envelope shaping and
 * per-room seq stamping live in RoomStore.broadcast and game.ts's waves.
 */

import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { isCommand, type ClientCommand, type Envelope } from '@five-hundred/protocol';
import { createGameSession, handleConvertSeatToBot, handleGameCommand, resumeView } from './game.js';
import { RoomStore, type Room, type RoomClient } from './rooms.js';

/**
 * E2E test mode: when TEST_SEED is set, every game starts from that fixed
 * seed with zero bot pacing, so a scripted browser run (e2e/smoke.test.ts)
 * is deterministic and fast. Unset — production — leaves both untouched.
 */
export function testSeed(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.TEST_SEED;
  if (raw === undefined || raw === '') return null;
  const seed = Number(raw);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error(`Invalid TEST_SEED value "${raw}" — expected an integer in 0..2^32-1.`);
  }
  return seed;
}

function defaultStartGame(room: Room): unknown {
  const seed = testSeed();
  return seed === null
    ? createGameSession(room)
    : createGameSession(room, seed, { bots: { delayMs: () => 0 } });
}

function makeClient(socket: WebSocket): RoomClient {
  return {
    send(envelope: Envelope): void {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(envelope));
    },
    close(): void {
      socket.close(1000, 'room closed');
    },
    room: null,
    seat: null,
    name: null,
  };
}

function dispatch(store: RoomStore, client: RoomClient, cmd: ClientCommand): void {
  switch (cmd.t) {
    case 'createRoom':
      store.createRoom(client, cmd.name);
      return;
    case 'joinRoom':
      store.joinRoom(client, cmd.roomCode, cmd.name, cmd.token);
      return;
    case 'sit':
      store.sit(client, cmd.seat);
      return;
    case 'configureBots':
      store.configureBots(client, cmd.bots);
      return;
    case 'setAdaptiveBots':
      store.setAdaptiveBots(client, cmd.on);
      return;
    case 'startGame':
      store.startGame(client);
      return;
    case 'rematch':
      store.rematch(client);
      return;
    case 'convertSeatToBot':
      handleConvertSeatToBot(client, cmd);
      return;
    case 'bid':
    case 'discardKeeps':
    case 'declareSlam':
    case 'declineSlam':
    case 'giveCard':
    case 'playCard':
    case 'nextHand':
    case 'requestState':
      handleGameCommand(client, cmd);
      return;
  }
}

export interface WsApp {
  wss: WebSocketServer;
  store: RoomStore;
  close(): void;
}

/** Attach the ws server + room store (with GC running) to an HTTP server. */
export function attachWs(
  server: Server,
  store: RoomStore = new RoomStore({ startGame: defaultStartGame, resumeView }),
): WsApp {
  const wss = new WebSocketServer({ server });
  store.startGc();

  wss.on('connection', (socket: WebSocket) => {
    const client = makeClient(socket);

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        client.send({
          event: { t: 'error', code: 'badCommand', message: 'Message is not valid JSON.' },
        });
        return;
      }
      if (!isCommand(parsed)) {
        client.send({
          event: { t: 'error', code: 'badCommand', message: 'Unknown or malformed command.' },
        });
        return;
      }
      dispatch(store, client, parsed);
    });

    socket.on('close', () => store.handleDisconnect(client));
    socket.on('error', () => socket.close());
  });

  return {
    wss,
    store,
    close(): void {
      store.stopGc();
      for (const socket of wss.clients) socket.terminate();
      wss.close();
    },
  };
}
