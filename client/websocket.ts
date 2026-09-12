/**
 * Client transport. Owns connection lifecycle, outbound batching, liveness and
 * reconnection; delegates the actual bytes to one of two channels:
 *
 *   WsChannel   a real WebSocket        (`npm start`, or any long-lived host)
 *   SseChannel  EventSource + POST      (Vercel, where upgrades are impossible)
 *
 * Which one is used is decided once, cheaply: an explicit `?transport=`, a
 * memoised answer from earlier in this tab's session, an injected PUBLIC_WS_URL,
 * or — by default — try WebSocket and fall back if the handshake does not land
 * within PROBE_TIMEOUT_MS.
 *
 * Everything above this module is transport-blind: it sends `ClientMessage`s and
 * receives `ServerMessage`s.
 */

import type { ClientMessage, ServerMessage } from '../shared/protocol.js';
import { PROTOCOL_VERSION } from '../shared/protocol.js';
import {
  clientId,
  forcedTransport,
  memoTransport,
  memoedTransport,
  realtimeHttpUrl,
  type TransportKind,
  websocketUrl,
  CONFIG,
} from './config.js';

export type TransportStatus = 'connecting' | 'online' | 'reconnecting' | 'offline';

export interface TransportHooks {
  onMessage(msg: ServerMessage): void;
  onStatus(status: TransportStatus, detail: string): void;
  /** Fired after a reconnect completes, so in-flight work can be re-sent. */
  onReconnected(): void;
  /** Highest op seq we already hold, used to request a delta. */
  getSince(): number;
}

/** How long to wait for a WebSocket handshake before falling back to SSE. */
const PROBE_TIMEOUT_MS = 2500;
/** Outbound coalescing window. 30Hz is smooth to watch and a third of the traffic of 90Hz. */
const FLUSH_INTERVAL_MS = 33;
/** Send a ping this often; used for the RTT readout and as a liveness check. */
const PING_INTERVAL_MS = 5000;
/** No pong within this window means the connection is dead even if the socket says otherwise. */
const PING_TIMEOUT_MS = 15_000;
/** Reconnect backoff bounds. */
const BACKOFF_MIN_MS = 300;
const BACKOFF_MAX_MS = 8000;
/** Outbound messages buffered while offline. Past this the oldest are dropped. */
const MAX_QUEUE = 600;

interface Channel {
  readonly kind: TransportKind;
  open(since: number): void;
  send(msgs: ClientMessage[]): void;
  close(): void;
}

export class Transport {
  private channel: Channel | null = null;
  private queue: ClientMessage[] = [];
  private flushTimer: number | null = null;
  private pingTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private attempt = 0;
  private lastPongAt = 0;
  private stopped = false;
  private everConnected = false;
  private probing = false;

  status: TransportStatus = 'connecting';
  kind: TransportKind = 'ws';
  /** Round-trip time in ms, or -1 before the first pong. */
  rtt = -1;
  /** Estimated offset to add to a local timestamp to get server time. */
  clockOffset = 0;

  constructor(
    private readonly room: string,
    private readonly name: string | null,
    private readonly hooks: TransportHooks,
  ) {}

  start(): void {
    this.stopped = false;
    const forced = forcedTransport();
    const memo = memoedTransport();
    if (forced !== null) {
      this.kind = forced;
      this.probing = false;
    } else if (CONFIG.wsUrl !== null) {
      // An explicitly configured WebSocket endpoint is not a guess.
      this.kind = 'ws';
      this.probing = false;
    } else if (memo !== null) {
      this.kind = memo;
      this.probing = memo === 'ws';
    } else {
      this.kind = 'ws';
      this.probing = true;
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer('flush');
    this.clearTimer('ping');
    this.clearTimer('reconnect');
    this.channel?.close();
    this.channel = null;
    this.setStatus('offline', 'stopped');
  }

  /** Queue a message. Sends are coalesced into one frame per flush window. */
  send(msg: ClientMessage): void {
    this.queue.push(msg);
    if (this.queue.length > MAX_QUEUE) {
      // Drop the oldest *drawing* traffic first; keep control messages.
      const keep = this.queue.filter((m) => m.t !== 'cursor' && m.t !== 'points');
      this.queue = keep.length > MAX_QUEUE / 2 ? keep.slice(-Math.floor(MAX_QUEUE / 2)) : keep;
    }
    if (this.flushTimer === null) {
      this.flushTimer = window.setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, FLUSH_INTERVAL_MS);
    }
  }

  /** Send immediately, bypassing the coalescing window (used for `end`). */
  sendNow(msg: ClientMessage): void {
    this.queue.push(msg);
    this.flush();
  }

  private flush(): void {
    if (this.queue.length === 0) return;
    if (this.channel === null || this.status !== 'online') return;
    const batch = this.queue;
    this.queue = [];
    try {
      this.channel.send(batch);
    } catch {
      // Put it back; the reconnect path will replay it.
      this.queue = batch.concat(this.queue);
      this.dropConnection('send_failed');
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.clearTimer('reconnect');
    this.setStatus(this.everConnected ? 'reconnecting' : 'connecting', `via ${this.kind}`);

    const since = this.hooks.getSince();
    const onMessage = (msg: ServerMessage) => this.handleMessage(msg);
    const onFailure = (reason: string) => this.handleFailure(reason);

    this.channel =
      this.kind === 'ws'
        ? new WsChannel(this.room, this.name, clientId, onMessage, onFailure, () => this.onOpen())
        : new SseChannel(this.room, this.name, clientId, onMessage, onFailure, () => this.onOpen());

    this.channel.open(since);

    if (this.probing && this.kind === 'ws') {
      // If the handshake has not completed in time, this host almost certainly
      // cannot upgrade (a serverless platform, or a proxy stripping Upgrade).
      window.setTimeout(() => {
        if (this.stopped || this.status === 'online') return;
        if (this.kind !== 'ws') return;
        this.probing = false;
        this.kind = 'sse';
        this.channel?.close();
        this.channel = null;
        this.connect();
      }, PROBE_TIMEOUT_MS);
    }
  }

  private onOpen(): void {
    // "Open" only means the channel exists; `welcome` is what confirms a join.
  }

  private handleMessage(msg: ServerMessage): void {
    if (msg.t === 'pong') {
      this.lastPongAt = Date.now();
      const rtt = this.lastPongAt - msg.ts;
      // Smooth the readout so a single slow sample does not make it jump.
      this.rtt = this.rtt < 0 ? rtt : Math.round(this.rtt * 0.7 + rtt * 0.3);
      this.clockOffset = msg.serverTime - (msg.ts + rtt / 2);
      return;
    }

    if (msg.t === 'welcome') {
      const first = !this.everConnected;
      this.everConnected = true;
      this.attempt = 0;
      this.probing = false;
      memoTransport(this.kind);
      this.lastPongAt = Date.now();
      this.setStatus('online', `via ${this.kind}`);
      this.startPings();
      this.hooks.onMessage(msg);
      if (!first) this.hooks.onReconnected();
      this.flush();
      return;
    }

    if (msg.t === 'reconnect') {
      // The serverless window is closing. Reopen without any backoff: the
      // server told us in advance, so this is not an error path.
      this.hooks.onMessage(msg);
      this.channel?.close();
      this.channel = null;
      this.setStatus('reconnecting', msg.reason);
      window.setTimeout(() => this.connect(), 0);
      return;
    }

    if (msg.t === 'error' && msg.fatal === true) {
      this.hooks.onMessage(msg);
      if (msg.code === 'version_mismatch') {
        // A new server is deployed; reloading is the only correct move.
        this.stop();
        return;
      }
      if (msg.code === 'superseded') {
        // Another tab took our identity. Do not fight over it.
        this.stop();
        return;
      }
      this.dropConnection(msg.code);
      return;
    }

    this.hooks.onMessage(msg);
  }

  private handleFailure(reason: string): void {
    if (this.stopped) return;
    // A failure during the probe is the signal to switch transports, not to back off.
    if (this.probing && this.kind === 'ws' && !this.everConnected) {
      this.probing = false;
      this.kind = 'sse';
      this.channel?.close();
      this.channel = null;
      this.connect();
      return;
    }
    this.dropConnection(reason);
  }

  private dropConnection(reason: string): void {
    this.clearTimer('ping');
    this.channel?.close();
    this.channel = null;
    if (this.stopped) return;
    this.setStatus('reconnecting', reason);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.attempt++;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (this.attempt - 1));
    // Full jitter: avoids a thundering herd when a server restarts.
    const wait = Math.round(base * (0.5 + Math.random() * 0.5));
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
  }

  private startPings(): void {
    this.clearTimer('ping');
    this.pingTimer = window.setInterval(() => {
      if (this.status !== 'online') return;
      if (Date.now() - this.lastPongAt > PING_TIMEOUT_MS) {
        this.dropConnection('ping_timeout');
        return;
      }
      this.sendNow({ t: 'ping', ts: Date.now() });
    }, PING_INTERVAL_MS);
  }

  private clearTimer(which: 'flush' | 'ping' | 'reconnect'): void {
    if (which === 'flush' && this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (which === 'ping' && this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (which === 'reconnect' && this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: TransportStatus, detail: string): void {
    if (this.status === status) return;
    this.status = status;
    this.hooks.onStatus(status, detail);
  }
}

/* ------------------------------------------------------------------ */
/* WebSocket channel                                                   */
/* ------------------------------------------------------------------ */

class WsChannel implements Channel {
  readonly kind = 'ws';
  private socket: WebSocket | null = null;
  private done = false;

  constructor(
    private readonly room: string,
    private readonly name: string | null,
    private readonly clientId: string,
    private readonly onMessage: (msg: ServerMessage) => void,
    private readonly onFailure: (reason: string) => void,
    private readonly onOpen: () => void,
  ) {}

  open(since: number): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(websocketUrl());
    } catch (err) {
      this.fail(`ws_ctor:${(err as Error).name}`);
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.onOpen();
      const hello: ClientMessage = { t: 'hello', room: this.room, clientId: this.clientId, v: PROTOCOL_VERSION };
      if (since > 0) hello.since = since;
      if (this.name !== null) hello.name = this.name;
      socket.send(JSON.stringify(hello));
    };
    socket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      // The server coalesces a tick's worth of messages into an array.
      if (Array.isArray(parsed)) {
        for (const m of parsed) this.onMessage(m as ServerMessage);
      } else {
        this.onMessage(parsed as ServerMessage);
      }
    };
    socket.onerror = () => this.fail('ws_error');
    socket.onclose = (ev) => this.fail(`ws_close_${ev.code}`);
  }

  send(msgs: ClientMessage[]): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) throw new Error('socket not open');
    socket.send(JSON.stringify(msgs.length === 1 ? msgs[0] : msgs));
  }

  close(): void {
    this.done = true;
    const socket = this.socket;
    this.socket = null;
    if (socket === null) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }

  private fail(reason: string): void {
    if (this.done) return;
    this.done = true;
    this.onFailure(reason);
  }
}

/* ------------------------------------------------------------------ */
/* SSE + POST channel                                                  */
/* ------------------------------------------------------------------ */

class SseChannel implements Channel {
  readonly kind = 'sse';
  private source: EventSource | null = null;
  private streamId: string;
  private done = false;
  private inflight: Promise<void> = Promise.resolve();

  constructor(
    private readonly room: string,
    private readonly name: string | null,
    private readonly clientId: string,
    private readonly onMessage: (msg: ServerMessage) => void,
    private readonly onFailure: (reason: string) => void,
    private readonly onOpen: () => void,
  ) {
    this.streamId = `s${Math.random().toString(36).slice(2, 10)}`;
  }

  open(since: number): void {
    const url = new URL(realtimeHttpUrl());
    url.searchParams.set('mode', 'stream');
    url.searchParams.set('room', this.room);
    url.searchParams.set('cid', this.clientId);
    url.searchParams.set('sid', this.streamId);
    if (since > 0) url.searchParams.set('since', String(since));
    if (this.name !== null) url.searchParams.set('name', this.name);

    const source = new EventSource(url.toString());
    this.source = source;
    source.onopen = () => this.onOpen();
    source.onmessage = (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (Array.isArray(parsed)) {
        for (const m of parsed) this.onMessage(m as ServerMessage);
      } else {
        this.onMessage(parsed as ServerMessage);
      }
    };
    source.onerror = () => {
      // EventSource retries on its own, but it would reuse a stale `since`, so
      // we take over the reconnection ourselves.
      this.fail('sse_error');
    };
  }

  send(msgs: ClientMessage[]): void {
    // Serialise POSTs: two concurrent batches could otherwise be applied out of
    // order, and stroke points must stay ordered.
    this.inflight = this.inflight.then(() => this.post(msgs)).catch(() => {});
  }

  private async post(msgs: ClientMessage[]): Promise<void> {
    if (this.done) return;
    let res: Response;
    try {
      res = await fetch(realtimeHttpUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sid: this.streamId, msgs }),
        keepalive: false,
      });
    } catch {
      this.fail('post_failed');
      return;
    }
    if (res.status === 409) {
      // Our stream is gone (expired, or this POST reached an instance that does
      // not own it). Reconnecting re-establishes the session and resyncs.
      this.fail('stream_lost');
      return;
    }
    if (!res.ok) this.fail(`post_${res.status}`);
  }

  close(): void {
    this.done = true;
    const source = this.source;
    this.source = null;
    if (source === null) return;
    source.onopen = null;
    source.onmessage = null;
    source.onerror = null;
    try {
      source.close();
    } catch {
      /* ignore */
    }
  }

  private fail(reason: string): void {
    if (this.done) return;
    this.done = true;
    this.onFailure(reason);
  }
}
