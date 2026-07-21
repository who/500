/**
 * WebSocket plumbing: attaches a `ws` WebSocketServer to the HTTP server,
 * adapts each socket onto the transport-agnostic RoomClient interface, and
 * dispatches guarded room-lifecycle commands into the RoomStore. Envelope
 * shaping and per-room seq stamping live in RoomStore.broadcast.
 *
 * Game commands (bid, playCard, …) are validated here but rejected until the
 * game-loop leaf wires the engine in.
 */

import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { isCommand, type ClientCommand, type Envelope } from '@five-hundred/protocol';
import { RoomStore, type RoomClient } from './rooms.js';

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
      store.joinRoom(client, cmd.roomCode, cmd.name);
      return;
    case 'sit':
      store.sit(client, cmd.seat);
      return;
    case 'configureBots':
      store.configureBots(client, cmd.bots);
      return;
    case 'startGame':
      store.startGame(client);
      return;
    default:
      // Game commands land in the game-loop leaf.
      client.send({
        event: {
          t: 'error',
          code: 'badCommand',
          message: `Command "${cmd.t}" is not supported yet.`,
        },
      });
  }
}

export interface WsApp {
  wss: WebSocketServer;
  store: RoomStore;
  close(): void;
}

/** Attach the ws server + room store (with GC running) to an HTTP server. */
export function attachWs(server: Server, store: RoomStore = new RoomStore()): WsApp {
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
