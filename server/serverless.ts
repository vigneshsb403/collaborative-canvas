/**
 * Serverless realtime transport: Server-Sent Events downstream + batched POST
 * upstream. This is what makes the app deployable to Vercel with zero config.
 *
 * Why not WebSockets on Vercel?
 * -----------------------------
 * Vercel Functions terminate HTTP; they cannot accept a WebSocket upgrade. So
 * the client falls back to a pair of plain HTTP calls:
 *
 *     GET  /api/rt?mode=stream   -> text/event-stream, stays open (~50s), the
 *                                   downstream channel. Opening it *is* the
 *                                   `hello`, since SSE has no upstream.
 *     POST /api/rt               -> a batch of client messages, ~40ms apart.
 *
 * Both live in ONE function file on purpose: every file under `api/` is a
 * separate lambda on Vercel, and two lambdas cannot share memory. Handling GET
 * and POST in the same function is what lets a POST find the session that its
 * SSE stream created.
 *
 * Known limitation: the room lives in the instance's memory, so correctness
 * depends on the stream and its POSTs landing on the same warm instance
 * (`regions: ["iad1"]` plus Fluid Compute concurrency make that the common
 * case for a small room). Set PUBLIC_WS_URL to point the client at a real
 * WebSocket server for guaranteed-consistent multi-instance operation — see
 * README § Deploying.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { ServerMessage } from '../shared/protocol.js';
import { PROTOCOL_VERSION } from '../shared/protocol.js';
import { Hub, MAX_FRAME_BYTES, type Session } from './hub.js';
import { type Connection, RoomRegistry, sanitizeRoomId } from './rooms.js';

/** How long a single SSE window stays open before asking the client to reopen. */
export const SSE_TTL_MS = Number(process.env.SSE_TTL_MS ?? 50_000);
/** SSE keep-alive comment interval — beats every proxy idle timeout. */
export const SSE_HEARTBEAT_MS = 15_000;
/** Give up on a stream whose socket is not draining. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** Maximum messages accepted in a single POST batch. */
const MAX_BATCH = 200;
/** Upstream request body cap. */
const MAX_BODY_BYTES = 256 * 1024;

export interface Runtime {
  registry: RoomRegistry;
  hub: Hub;
  /** Open SSE windows, keyed by stream id. This is what a POST looks up. */
  sessions: Map<string, StreamEntry>;
  startedAt: number;
}

interface StreamEntry {
  conn: SseConnection;
  session: Session;
}

/**
 * The runtime is stashed on `globalThis` rather than in a module-level `let`:
 * a serverless runtime may evaluate the module more than once per instance
 * (different bundles, ESM/CJS interop), and losing the room registry would
 * silently reset the canvas.
 */
const RUNTIME_KEY = '__collabCanvasRuntime__';

export function getRuntime(): Runtime {
  const g = globalThis as unknown as Record<string, Runtime | undefined>;
  let rt = g[RUNTIME_KEY];
  if (rt === undefined) {
    const registry = new RoomRegistry();
    rt = {
      registry,
      hub: new Hub(registry, {
        log: (event, detail) => {
          if (process.env.QUIET_LOGS === '1') return;
          console.log(`[rt] ${event}`, JSON.stringify(detail));
        },
      }),
      sessions: new Map(),
      startedAt: Date.now(),
    };
    g[RUNTIME_KEY] = rt;
  }
  return rt;
}

/** An SSE response wearing the `Connection` interface. */
export class SseConnection implements Connection {
  readonly kind = 'sse';
  private pending: string[] = [];
  private flushScheduled = false;
  private ended = false;

  constructor(
    readonly id: string,
    private readonly res: ServerResponse,
    private readonly onEnd: (reason: string) => void,
  ) {}

  send(msg: ServerMessage): void {
    if (this.ended) return;
    this.pending.push(`data: ${JSON.stringify(msg)}\n\n`);
    // Coalesce every message produced in this tick into one socket write: a
    // single broadcast of `points` to N members otherwise costs N small writes.
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => this.flush());
    }
  }

  flush(): void {
    this.flushScheduled = false;
    if (this.ended || this.pending.length === 0) return;
    const payload = this.pending.join('');
    this.pending.length = 0;
    try {
      this.res.write(payload);
      if (this.res.writableLength > MAX_BUFFERED_BYTES) {
        this.close('backpressure');
      }
    } catch {
      this.close('write_failed');
    }
  }

  /** Keep-alive comment; also detects a half-open socket. */
  heartbeat(): void {
    if (this.ended) return;
    try {
      this.res.write(`: hb ${Date.now()}\n\n`);
    } catch {
      this.close('write_failed');
    }
  }

  close(reason = 'closed'): void {
    if (this.ended) return;
    this.flush();
    this.ended = true;
    try {
      this.res.end();
    } catch {
      /* socket already gone */
    }
    this.onEnd(reason);
  }

  get isEnded(): boolean {
    return this.ended;
  }
}

/* ------------------------------------------------------------------ */
/* Request handling                                                    */
/* ------------------------------------------------------------------ */

/**
 * The single entry point used by `api/rt.ts` (Vercel) and mounted by the
 * long-lived express server at the same path, so both deployments run the same
 * code path and the SSE transport is testable locally.
 */
export async function handleRealtimeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rt = getRuntime();
  rt.registry.sweep();

  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = (req.method ?? 'GET').toUpperCase();

  res.setHeader('Cache-Control', 'no-store, no-transform');

  if (method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (method === 'GET') {
    const mode = url.searchParams.get('mode') ?? 'stream';
    if (mode === 'health') {
      sendJson(res, 200, {
        ok: true,
        transport: 'sse',
        protocol: PROTOCOL_VERSION,
        uptimeMs: Date.now() - rt.startedAt,
        streams: rt.sessions.size,
        ...rt.registry.stats(),
      });
      return;
    }
    openStream(req, res, url);
    return;
  }

  if (method === 'POST') {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'bad_body', message: (err as Error).message });
      return;
    }
    handleBatch(res, body);
    return;
  }

  res.statusCode = 405;
  res.setHeader('Allow', 'GET, POST, OPTIONS');
  res.end();
}

function openStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const rt = getRuntime();
  const streamId = url.searchParams.get('sid') ?? randomBytes(9).toString('base64url');
  const clientId = url.searchParams.get('cid') ?? '';
  const room = sanitizeRoomId(url.searchParams.get('room'));
  const name = url.searchParams.get('name') ?? undefined;
  const sinceRaw = Number(url.searchParams.get('since') ?? '0');
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;

  // A reopened stream reuses its id; retire the previous window first.
  rt.sessions.get(streamId)?.conn.close('reopened');

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Connection', 'keep-alive');
  // Defeat proxy buffering, which would otherwise hold events until the
  // response completes and make the whole thing look broken.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(`retry: 1000\n`);
  res.write(`: stream ${streamId}\n\n`);

  let ttlTimer: NodeJS.Timeout | undefined;
  let hbTimer: NodeJS.Timeout | undefined;

  const conn = new SseConnection(streamId, res, (reason) => {
    if (ttlTimer !== undefined) clearTimeout(ttlTimer);
    if (hbTimer !== undefined) clearInterval(hbTimer);
    const entry = rt.sessions.get(streamId);
    if (entry !== undefined && entry.conn === conn) {
      rt.sessions.delete(streamId);
      rt.hub.disconnect(entry.session, reason);
    }
  });

  const session = rt.hub.newSession(conn);
  rt.sessions.set(streamId, { conn, session });

  // Opening the stream is the join: SSE has no upstream channel, so the query
  // string carries what a `hello` frame would.
  rt.hub.handle(session, {
    t: 'hello',
    room,
    clientId,
    name,
    since,
    v: PROTOCOL_VERSION,
  });

  hbTimer = setInterval(() => conn.heartbeat(), SSE_HEARTBEAT_MS);
  ttlTimer = setTimeout(() => {
    // The function is about to hit its wall-clock limit. Ask for a fresh window
    // *before* the platform kills the socket, so the client never sees an error.
    conn.send({ t: 'reconnect', reason: 'window_expired' });
    conn.flush();
    setTimeout(() => conn.close('window_expired'), 50);
  }, SSE_TTL_MS);

  const drop = (reason: string) => () => conn.close(reason);
  req.on('close', drop('client_closed'));
  req.on('error', drop('request_error'));
  res.on('error', drop('response_error'));
}

function handleBatch(res: ServerResponse, body: unknown): void {
  const rt = getRuntime();
  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, { error: 'bad_body' });
    return;
  }
  const { sid, msgs } = body as { sid?: unknown; msgs?: unknown };
  if (typeof sid !== 'string' || !Array.isArray(msgs)) {
    sendJson(res, 400, { error: 'bad_body' });
    return;
  }
  const entry = rt.sessions.get(sid);
  if (entry === undefined || entry.conn.isEnded) {
    // Either the stream expired, or this POST was routed to an instance that
    // does not own the stream. The client reopens its stream and resyncs.
    sendJson(res, 409, { error: 'no_stream', message: 'Unknown or expired stream id.' });
    return;
  }
  if (msgs.length > MAX_BATCH) {
    sendJson(res, 413, { error: 'batch_too_large' });
    return;
  }
  let handled = 0;
  for (const msg of msgs) {
    // `hello` only ever comes from opening the stream.
    if (typeof msg === 'object' && msg !== null && (msg as { t?: unknown }).t === 'hello') continue;
    rt.hub.handle(entry.session, msg);
    handled++;
  }
  entry.conn.flush();
  sendJson(res, 200, { ok: true, handled });
}

/* ------------------------------------------------------------------ */

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

/**
 * Read a JSON body. Vercel's Node runtime pre-parses `req.body`; express does
 * too when `express.json()` is mounted; a bare `node:http` server does neither.
 * All three are handled.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const pre = (req as IncomingMessage & { body?: unknown }).body;
  if (pre !== undefined && pre !== null) {
    if (typeof pre === 'string') return pre.length === 0 ? {} : JSON.parse(pre);
    if (Buffer.isBuffer(pre)) return pre.length === 0 ? {} : JSON.parse(pre.toString('utf8'));
    return pre;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('Body too large');
    chunks.push(buf);
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length > MAX_FRAME_BYTES * 4) throw new Error('Body too large');
  return JSON.parse(text);
}

/** Test/shutdown helper: close every open stream. */
export function closeAllStreams(reason = 'shutdown'): void {
  for (const entry of [...getRuntime().sessions.values()]) entry.conn.close(reason);
}
