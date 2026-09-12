/**
 * Long-lived Express + WebSocket server. This is the primary, fully consistent
 * deployment target (`npm start`, or any host that keeps a process alive).
 *
 * It also mounts the serverless SSE transport at the same path Vercel exposes
 * (`/api/rt`), which means:
 *   - the fallback transport can be developed and tested locally, and
 *   - a WebSocket client and an SSE client can share a room in-process, which is
 *     exactly what the integration tests exercise.
 *
 * Everything is wrapped in `createCanvasServer()` so the test suite can start a
 * real server on an ephemeral port; the module only listens on import when it is
 * the process entry point.
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ServerMessage } from '../shared/protocol.js';
import { PROTOCOL_VERSION } from '../shared/protocol.js';
import { Hub, MAX_FRAME_BYTES } from './hub.js';
import { RoomRegistry, type Connection } from './rooms.js';
import { closeAllStreams, getRuntime, handleRealtimeRequest } from './serverless.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? join(HERE, '..', '..', 'public');

/** WebSocket liveness probe interval. Two missed probes close the socket. */
const PING_INTERVAL_MS = 25_000;
const ROOM_SWEEP_INTERVAL_MS = 60_000;

export interface CanvasServer {
  server: Server;
  wss: WebSocketServer;
  hub: Hub;
  registry: RoomRegistry;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

let connectionSeq = 0;

/** A `ws` socket wearing the transport-agnostic `Connection` interface. */
class WsConnection implements Connection {
  readonly kind = 'ws';
  private pending: ServerMessage[] = [];
  private flushScheduled = false;
  private closed = false;
  alive = true;

  constructor(readonly id: string, private readonly socket: WebSocket) {}

  send(msg: ServerMessage): void {
    if (this.closed) return;
    this.pending.push(msg);
    // Coalesce everything produced in this tick into a single frame. During a
    // busy multi-user session one tick often carries several `points` messages
    // plus a `cursor`; one frame instead of four saves headers and syscalls.
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => this.flush());
    }
  }

  flush(): void {
    this.flushScheduled = false;
    if (this.closed || this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    // One message goes out bare; several go out as a JSON array. The client
    // accepts both shapes.
    const payload = batch.length === 1 ? JSON.stringify(batch[0]) : JSON.stringify(batch);
    try {
      this.socket.send(payload);
    } catch {
      this.close('send_failed');
    }
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    try {
      // 1000 = normal closure. The reason must stay under 123 bytes.
      this.socket.close(1000, reason.slice(0, 120));
    } catch {
      try {
        this.socket.terminate();
      } catch {
        /* already gone */
      }
    }
  }
}

export interface CanvasServerOptions {
  /** Defaults to the process-wide runtime, which the SSE transport also uses. */
  registry?: RoomRegistry;
  hub?: Hub;
  /** Static asset root. Defaults to ../../public relative to the built file. */
  publicDir?: string;
  /** Skip static file serving (tests don't need a build to exist). */
  serveStatic?: boolean;
}

export function createCanvasServer(opts: CanvasServerOptions = {}): CanvasServer {
  const runtime = getRuntime();
  const registry = opts.registry ?? runtime.registry;
  const hub = opts.hub ?? runtime.hub;
  const publicDir = opts.publicDir ?? PUBLIC_DIR;
  const serveStatic = opts.serveStatic !== false;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // The serverless realtime endpoint, mounted at the exact path Vercel serves.
  // Note this always uses the process-wide runtime (SSE sessions are global).
  app.all('/api/rt', (req, res) => {
    void handleRealtimeRequest(req, res);
  });

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      transport: 'ws',
      protocol: PROTOCOL_VERSION,
      uptimeSec: Math.round(process.uptime()),
      ...registry.stats(),
    });
  });

  if (serveStatic) {
    // Bundles are content-hashed and immutable; the HTML shell and the runtime
    // config must never be cached, or a deploy that bumps the protocol version
    // would leave stale clients reconnecting forever.
    app.use(
      express.static(publicDir, {
        etag: true,
        maxAge: '1h',
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html') || filePath.endsWith('config.js')) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );

    // Unknown paths serve the app shell so /any-room-name style links work.
    app.use((_req, res) => {
      res.sendFile(join(publicDir, 'index.html'), (err) => {
        if (err) {
          res.status(404).type('text/plain').send('Not found. Did you run `npm run build`?');
        }
      });
    });
  }

  const server = createHttpServer(app);
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: MAX_FRAME_BYTES,
    // Disabled on purpose: our frames are small and latency-sensitive, and
    // per-message deflate costs CPU plus a compression context per socket.
    perMessageDeflate: false,
  });

  /** Lets the liveness sweep find the wrapper for a raw socket. */
  const wrappers = new WeakMap<WebSocket, WsConnection>();

  wss.on('connection', (socket, req) => {
    const conn = new WsConnection(`ws-${++connectionSeq}`, socket);
    wrappers.set(socket, conn);
    const session = hub.newSession(conn);
    const peer = req.socket.remoteAddress ?? 'unknown';

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        // The protocol is JSON text only; a binary frame is a client bug.
        hub.handle(session, null);
        return;
      }
      hub.handleRaw(session, typeof data === 'string' ? data : data.toString('utf8'));
    });

    socket.on('pong', () => {
      conn.alive = true;
    });

    socket.on('close', (code) => {
      hub.disconnect(session, `ws_close_${code}`);
    });

    socket.on('error', (err) => {
      if (process.env.QUIET_LOGS !== '1') console.warn(`[ws] socket error from ${peer}:`, err.message);
      hub.disconnect(session, 'ws_error');
    });
  });

  /** Drop sockets that stopped answering pings (half-open TCP, sleeping laptop). */
  const pingTimer = setInterval(() => {
    for (const socket of wss.clients) {
      const conn = wrappers.get(socket);
      if (conn !== undefined && !conn.alive) {
        socket.terminate();
        continue;
      }
      if (conn !== undefined) conn.alive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }, PING_INTERVAL_MS);
  pingTimer.unref();

  const sweepTimer = setInterval(() => registry.sweep(), ROOM_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  return {
    server,
    wss,
    hub,
    registry,
    listen(port, host = '0.0.0.0') {
      return new Promise((res2, rej) => {
        server.once('error', rej);
        server.listen(port, host, () => {
          const addr = server.address();
          res2(typeof addr === 'object' && addr !== null ? addr.port : port);
        });
      });
    },
    async close() {
      clearInterval(pingTimer);
      clearInterval(sweepTimer);
      closeAllStreams('shutdown');
      for (const socket of wss.clients) {
        try {
          socket.close(1001, 'server shutting down');
        } catch {
          socket.terminate();
        }
      }
      await new Promise<void>((res2) => wss.close(() => res2()));
      await new Promise<void>((res2) => server.close(() => res2()));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

function isEntryPoint(): boolean {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  try {
    return resolve(arg) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

if (isEntryPoint()) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  const instance = createCanvasServer();

  instance
    .listen(port, host)
    .then((bound) => {
      const lan = lanAddress();
      console.log(`\n  Collaborative canvas — protocol v${PROTOCOL_VERSION}`);
      console.log(`  local:   http://localhost:${bound}`);
      if (lan !== null) console.log(`  network: http://${lan}:${bound}   <- open on a phone or second laptop`);
      console.log(`  ws:      ws://localhost:${bound}/ws`);
      console.log(`  sse:     http://localhost:${bound}/api/rt   (force it with ?transport=sse)\n`);
    })
    .catch((err: Error) => {
      console.error(`[server] failed to listen on ${host}:${port} — ${err.message}`);
      process.exit(1);
    });

  const shutdown = (signal: string) => {
    console.log(`\n[server] ${signal} — shutting down`);
    void instance.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
