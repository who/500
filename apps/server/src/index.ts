/**
 * @five-hundred/server — HTTP + WebSocket server.
 *
 * Serves GET /healthz and, when a client build exists (apps/client/dist),
 * the built client as static files. WebSocket room lifecycle is attached in
 * ws.ts; the authoritative game loop lands in a later issue.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BOTS_NAME } from '@five-hundred/bots';
import { ENGINE_NAME } from '@five-hundred/engine';
import { PROTOCOL_VERSION } from '@five-hundred/protocol';
import { attachWs } from './ws.js';

export const APP_NAME = 'Five Hundred';
export const DEFAULT_PORT = 8500;

export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT value "${raw}" — expected an integer in 0..65535.`);
  }
  return port;
}

const CLIENT_DIST = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'client', 'dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const relative = normalize(pathname).replace(/^([/\\]|\.\.)+/, '');
  const candidates = [join(CLIENT_DIST, relative || 'index.html')];
  if (!extname(relative)) candidates.push(join(CLIENT_DIST, 'index.html')); // SPA fallback
  for (const file of candidates) {
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME_TYPES[extname(file)] ?? 'application/octet-stream',
      });
      res.end(body);
      return;
    } catch {
      continue;
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${APP_NAME}: no client build found — run \`pnpm build\` (dev client runs on Vite).\n`);
}

export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        status: 'ok',
        app: APP_NAME,
        protocolVersion: PROTOCOL_VERSION,
        packages: [ENGINE_NAME, BOTS_NAME],
      }),
    );
    return;
  }
  void serveStatic(pathname, res);
}

export function startServer(port: number = resolvePort()): ReturnType<typeof createServer> {
  const server = createServer(handleRequest);
  attachWs(server);
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[${APP_NAME}] Port ${port} is already in use. ` +
          `Stop the other process or choose another port, e.g. \`PORT=${port + 1} pnpm dev\`.`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  });
  server.listen(port, () => {
    console.log(`[${APP_NAME}] server listening on http://localhost:${port} (GET /healthz, ws rooms)`);
  });
  return server;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  startServer();
}
