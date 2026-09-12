/**
 * Test harness: starts a real server on an ephemeral port and gives each test a
 * scriptable client for both transports.
 *
 * Nothing here is mocked — the WebSocket client is `ws`, and the SSE client uses
 * global `fetch` against the same `/api/rt` endpoint Vercel serves. Every test
 * therefore exercises the production code path end to end.
 */

import { WebSocket } from 'ws';
import { createCanvasServer, type CanvasServer } from '../server/server.js';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../shared/protocol.js';

export interface Harness {
  port: number;
  server: CanvasServer;
  close(): Promise<void>;
}

export async function startHarness(opts: { serveStatic?: boolean } = {}): Promise<Harness> {
  const server = createCanvasServer({ serveStatic: opts.serveStatic === true });
  const port = await server.listen(0, '127.0.0.1');
  return {
    port,
    server,
    close: () => server.close(),
  };
}

let idCounter = 0;

/** A fresh, valid clientId (6-48 chars of [A-Za-z0-9_-]). */
export function newClientId(label = 'user'): string {
  return `${label}-${(++idCounter).toString().padStart(4, '0')}-tst`;
}

/** Common surface for the two transport-specific test clients. */
export abstract class BaseClient {
  readonly received: ServerMessage[] = [];
  protected waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  userId: string | null = null;

  constructor(readonly clientId: string) {}

  abstract send(msg: ClientMessage): void;
  abstract close(): Promise<void>;

  protected ingest(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const list: ServerMessage[] = Array.isArray(parsed) ? parsed : [parsed as ServerMessage];
    for (const msg of list) {
      this.received.push(msg);
      if (msg.t === 'welcome') this.userId = msg.you.id;
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const w = this.waiters[i]!;
        if (w.pred(msg)) {
          clearTimeout(w.timer);
          this.waiters.splice(i, 1);
          w.resolve(msg);
        }
      }
    }
  }

  /** Resolve with the first message (already received or future) matching `pred`. */
  waitFor<T extends ServerMessage = ServerMessage>(
    pred: (m: ServerMessage) => boolean,
    timeoutMs = 4000,
    label = 'message',
  ): Promise<T> {
    const existing = this.received.find(pred);
    if (existing !== undefined) return Promise.resolve(existing as T);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}; saw: ${this.received.map((m) => m.t).join(',')}`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve: resolve as (m: ServerMessage) => void, reject, timer });
    });
  }

  waitForType<T extends ServerMessage['t']>(type: T, timeoutMs = 4000): Promise<Extract<ServerMessage, { t: T }>> {
    return this.waitFor<Extract<ServerMessage, { t: T }>>((m) => m.t === type, timeoutMs, `"${type}"`);
  }

  ofType<T extends ServerMessage['t']>(type: T): Extract<ServerMessage, { t: T }>[] {
    return this.received.filter((m) => m.t === type) as Extract<ServerMessage, { t: T }>[];
  }

  clearReceived(): void {
    this.received.length = 0;
  }
}

/** WebSocket test client. */
export class WsClient extends BaseClient {
  private socket: WebSocket;
  private openPromise: Promise<void>;
  closedCode: number | null = null;

  constructor(port: number, clientId: string) {
    super(clientId);
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.openPromise = new Promise((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
    this.socket.on('message', (data) => this.ingest(data.toString('utf8')));
    this.socket.on('close', (code) => {
      this.closedCode = code;
    });
  }

  async ready(): Promise<void> {
    await this.openPromise;
  }

  send(msg: ClientMessage): void {
    this.socket.send(JSON.stringify(msg));
  }

  /** Send a raw string, for protocol-violation tests. */
  sendRaw(raw: string): void {
    this.socket.send(raw);
  }

  async hello(room: string, opts: { since?: number; name?: string; v?: number } = {}): Promise<Extract<ServerMessage, { t: 'welcome' }>> {
    await this.ready();
    const msg: ClientMessage = {
      t: 'hello',
      room,
      clientId: this.clientId,
      v: opts.v ?? PROTOCOL_VERSION,
    };
    if (opts.since !== undefined) msg.since = opts.since;
    if (opts.name !== undefined) msg.name = opts.name;
    this.send(msg);
    return this.waitForType('welcome');
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.close();
      setTimeout(resolve, 500);
    });
  }

  /** Simulate a network drop: no close frame, just a dead socket. */
  kill(): void {
    this.socket.terminate();
  }
}

/** SSE + POST test client, mirroring what the browser fallback does. */
export class SseClient extends BaseClient {
  readonly streamId: string;
  private controller: AbortController | null = null;
  private base: string;
  private pump: Promise<void> | null = null;
  streamEnded = false;

  constructor(port: number, clientId: string, streamId?: string) {
    super(clientId);
    this.base = `http://127.0.0.1:${port}/api/rt`;
    this.streamId = streamId ?? `s-${clientId}`;
  }

  async open(room: string, opts: { since?: number; name?: string } = {}): Promise<Extract<ServerMessage, { t: 'welcome' }>> {
    const params = new URLSearchParams({ mode: 'stream', room, cid: this.clientId, sid: this.streamId });
    if (opts.since !== undefined) params.set('since', String(opts.since));
    if (opts.name !== undefined) params.set('name', opts.name);
    this.controller = new AbortController();
    this.streamEnded = false;
    const res = await fetch(`${this.base}?${params.toString()}`, {
      headers: { accept: 'text/event-stream' },
      signal: this.controller.signal,
    });
    if (res.body === null) throw new Error('no SSE body');
    this.pump = this.readStream(res.body);
    return this.waitForType('welcome');
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (line.startsWith('data: ')) this.ingest(line.slice(6));
          }
        }
      }
    } catch {
      /* aborted */
    } finally {
      this.streamEnded = true;
    }
  }

  /** POST a batch upstream, exactly as the browser transport does. */
  async post(...msgs: ClientMessage[]): Promise<{ status: number; body: unknown }> {
    const res = await fetch(this.base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sid: this.streamId, msgs }),
    });
    return { status: res.status, body: await res.json() };
  }

  send(msg: ClientMessage): void {
    void this.post(msg);
  }

  async close(): Promise<void> {
    this.controller?.abort();
    await this.pump?.catch(() => {});
    // Give the server a tick to notice the closed socket.
    await delay(30);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until `pred` holds, polling. Fails the test on timeout. */
export async function until(pred: () => boolean, timeoutMs = 3000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Straight line of `n` points from (x0,y0) to (x1,y1), as a flat array. */
export function line(x0: number, y0: number, x1: number, y1: number, n = 8): number[] {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    pts.push(Math.round((x0 + (x1 - x0) * t) * 10) / 10, Math.round((y0 + (y1 - y0) * t) * 10) / 10);
  }
  return pts;
}

let strokeCounter = 0;

/** Draw a complete stroke through begin/points/end and resolve with the commit. */
export async function drawStroke(
  client: BaseClient,
  opts: {
    color?: string;
    width?: number;
    tool?: 'brush' | 'eraser';
    points?: number[];
    chunks?: number;
  } = {},
): Promise<Extract<ServerMessage, { t: 'commit' }>> {
  if (client.userId === null) throw new Error('client has not joined');
  const sid = `${client.userId}-t${++strokeCounter}`;
  const pts = opts.points ?? line(10 + strokeCounter, 10, 100 + strokeCounter, 100, 10);
  const style = { color: opts.color ?? '#123456', width: opts.width ?? 4, tool: opts.tool ?? ('brush' as const) };

  const chunks = Math.max(1, opts.chunks ?? 2);
  const perChunk = Math.ceil(pts.length / 2 / chunks) * 2;

  client.send({ t: 'begin', sid, style, pts: pts.slice(0, perChunk) });
  for (let i = perChunk; i < pts.length; i += perChunk) {
    client.send({ t: 'points', sid, pts: pts.slice(i, i + perChunk) });
  }
  client.send({ t: 'end', sid, n: pts.length / 2 });
  return client.waitFor<Extract<ServerMessage, { t: 'commit' }>>(
    (m) => m.t === 'commit' && m.sid === sid,
    4000,
    `commit of ${sid}`,
  );
}
