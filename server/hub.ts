/**
 * Protocol dispatcher — the only place that knows what each message means.
 *
 * The hub is deliberately transport-agnostic: it talks to a `Connection`
 * interface, so the exact same logic serves the long-lived WebSocket server
 * (`server/server.ts`) and the serverless SSE + POST pair (`api/*.ts`). Adding a
 * third transport would mean implementing two methods.
 *
 * Invariants enforced here:
 *   - `hello` must be the first message; everything else is refused until then.
 *   - every value that reaches shared state has been through a sanitiser
 *     (`shared/geometry.ts`, `server/rooms.ts`).
 *   - a client is never trusted about *who* it is beyond its opaque clientId,
 *     nor about ordering: `seq` is assigned by `DrawingState`.
 */

import type {
  ClientMessage,
  Op,
  ServerMessage,
  SSync,
  SWelcome,
  UndoScope,
} from '../shared/protocol.js';
import { LIMITS, PROTOCOL_VERSION } from '../shared/protocol.js';
import {
  consumeToken,
  type Connection,
  type Member,
  Room,
  RoomRegistry,
  sanitizeRoomId,
  sanitizeUserId,
} from './rooms.js';

/** Minimum interval between broadcast cursor updates, per user. */
const CURSOR_MIN_INTERVAL_MS = 22;
/** At most one rate-limit complaint per connection per this interval. */
const RATE_NOTICE_INTERVAL_MS = 2000;
/** Prefer a full snapshot once a delta would carry more than this share of the log. */
const DELTA_MAX_SHARE = 0.6;

export interface Session {
  readonly conn: Connection;
  room: Room | null;
  userId: string | null;
  member: Member | null;
  closed: boolean;
  lastNotice: number;
  /** Cheap abuse signal: protocol errors in a row. */
  strikes: number;
}

export interface HubOptions {
  /** Called for every log-worthy event. Defaults to a no-op (tests stay quiet). */
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export class Hub {
  private readonly log: (event: string, detail: Record<string, unknown>) => void;

  constructor(readonly rooms: RoomRegistry, opts: HubOptions = {}) {
    this.log = opts.log ?? (() => {});
  }

  newSession(conn: Connection): Session {
    return { conn, room: null, userId: null, member: null, closed: false, lastNotice: 0, strikes: 0 };
  }

  /** Parse and dispatch a raw frame. Returns false if the frame was rejected. */
  handleRaw(session: Session, raw: string): boolean {
    if (raw.length > MAX_FRAME_BYTES) {
      this.fatal(session, 'too_large', 'Message exceeds the size limit.');
      return false;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.fatal(session, 'bad_json', 'Malformed JSON frame.');
      return false;
    }
    // The client coalesces everything it produced in one animation frame into a
    // single array frame, so a busy stroke costs one send instead of three.
    if (Array.isArray(parsed)) {
      if (parsed.length > MAX_BATCH_MESSAGES) {
        this.fatal(session, 'batch_too_large', `At most ${MAX_BATCH_MESSAGES} messages per frame.`);
        return false;
      }
      let allOk = true;
      for (const msg of parsed) {
        if (!this.handle(session, msg)) allOk = false;
      }
      return allOk;
    }
    return this.handle(session, parsed);
  }

  handle(session: Session, raw: unknown): boolean {
    if (session.closed) return false;
    if (typeof raw !== 'object' || raw === null) {
      return this.protocolError(session, 'bad_message', 'Message must be an object.');
    }
    const msg = raw as ClientMessage;

    if (msg.t === 'hello') return this.onHello(session, msg);

    const room = session.room;
    const member = session.member;
    const userId = session.userId;
    if (room === null || member === null || userId === null) {
      return this.protocolError(session, 'not_joined', 'Send `hello` first.');
    }

    member.lastSeen = Date.now();
    room.lastActivity = member.lastSeen;

    // Cursor updates are the cheapest and most frequent message; they get their
    // own throttle so they can never starve drawing traffic of rate budget.
    if (msg.t === 'cursor') {
      return this.onCursor(session, room, member, msg.x, msg.y, msg.active === true);
    }

    if (!consumeToken(member, 1, member.lastSeen)) {
      this.notice(session, 'rate_limited', 'Slow down — dropping messages.');
      return false;
    }

    switch (msg.t) {
      case 'begin': {
        const res = room.state.beginStroke(userId, msg.sid, msg.style, msg.pts);
        if (!res.ok) return this.protocolError(session, res.code, res.message);
        const live = res.value;
        room.broadcast({ t: 'begin', sid: live.sid, userId, style: live.style, pts: live.pts }, userId);
        return true;
      }
      case 'points': {
        const res = room.state.addPoints(userId, msg.sid, msg.pts);
        if (!res.ok) return this.softFail(session, res.code, res.message);
        if (res.value.length > 0) {
          room.broadcast({ t: 'points', sid: msg.sid, userId, pts: res.value }, userId);
        }
        return true;
      }
      case 'end': {
        const res = room.state.endStroke(userId, msg.sid, typeof msg.n === 'number' ? msg.n : undefined);
        if (!res.ok) {
          // An empty stroke is a normal outcome (a click that never moved and
          // was deduped away), not a protocol violation.
          if (res.code === 'empty_stroke') {
            room.broadcast({ t: 'cancel', sid: String(msg.sid), userId }, userId);
            return true;
          }
          return this.softFail(session, res.code, res.message);
        }
        const { op, desync } = res.value;
        if (desync) {
          this.log('stroke_desync', { room: room.id, userId, sid: op.id, points: op.pts.length >> 1 });
        }
        room.broadcast({ t: 'commit', sid: op.id, op, hv: room.state.log.hv });
        return true;
      }
      case 'cancel': {
        const res = room.state.cancelStroke(userId, msg.sid);
        if (!res.ok) return true; // idempotent: nothing to cancel is fine
        room.broadcast({ t: 'cancel', sid: res.value, userId }, userId);
        return true;
      }
      case 'undo':
      case 'redo': {
        const scope: UndoScope = msg.scope === 'mine' ? 'mine' : 'global';
        const res = msg.t === 'undo' ? room.state.undo(userId, scope) : room.state.redo(userId, scope);
        if (!res.ok) {
          this.notice(session, res.code, res.message);
          return true;
        }
        room.broadcast({
          t: 'vis',
          changes: res.value.changes,
          by: userId,
          action: msg.t,
          hv: res.value.hv,
          seq: room.state.log.seq,
        });
        return true;
      }
      case 'clear': {
        const res = room.state.clear(userId);
        if (!res.ok) {
          this.notice(session, res.code, res.message);
          return true;
        }
        room.broadcast({
          t: 'vis',
          changes: [],
          op: res.value,
          by: userId,
          action: 'clear',
          hv: room.state.log.hv,
          seq: room.state.log.seq,
        });
        return true;
      }
      case 'rename': {
        const name = room.rename(userId, String(msg.name ?? ''));
        if (name === null) return true;
        room.broadcast({ t: 'rename', userId, name });
        return true;
      }
      case 'ping': {
        session.conn.send({ t: 'pong', ts: typeof msg.ts === 'number' ? msg.ts : 0, serverTime: Date.now() });
        return true;
      }
      case 'resync': {
        session.conn.send(this.buildSync(room, typeof msg.since === 'number' ? msg.since : 0));
        return true;
      }
      default:
        return this.protocolError(session, 'unknown_type', `Unknown message type.`);
    }
  }

  /* ---------------------------------------------------------------- */

  private onHello(session: Session, msg: ClientMessage & { t: 'hello' }): boolean {
    if (session.userId !== null) {
      return this.protocolError(session, 'already_joined', 'Already joined.');
    }
    if (msg.v !== PROTOCOL_VERSION) {
      this.fatal(session, 'version_mismatch', `Server speaks protocol v${PROTOCOL_VERSION}; reload the page.`);
      return false;
    }
    const userId = sanitizeUserId(msg.clientId);
    if (userId === null) {
      this.fatal(session, 'bad_client_id', 'clientId must be 6-48 chars of [A-Za-z0-9_-].');
      return false;
    }
    const roomId = sanitizeRoomId(msg.room);
    const room = this.rooms.get(roomId);
    const { member, replaced } = room.join(userId, session.conn, msg.name);

    session.room = room;
    session.userId = userId;
    session.member = member;

    if (replaced !== null && replaced.id !== session.conn.id) {
      // Same identity reconnected before we noticed the old socket was gone.
      replaced.send({ t: 'error', code: 'superseded', message: 'Replaced by a newer connection.', fatal: true });
      replaced.close('superseded');
    }

    const since = typeof msg.since === 'number' ? msg.since : 0;
    const sync = this.buildSync(room, since);
    const welcome: SWelcome = {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      room: room.id,
      you: member.user,
      users: room.users(),
      ops: sync.ops,
      live: room.liveStrokesFor(userId),
      seq: room.state.log.seq,
      hv: room.state.log.hv,
      partial: sync.partial,
      limits: LIMITS,
      serverTime: Date.now(),
    };
    if (sync.undone !== undefined) welcome.undone = sync.undone;
    session.conn.send(welcome);
    room.broadcast({ t: 'join', user: member.user }, userId);
    this.log('join', { room: room.id, userId, kind: session.conn.kind, users: room.size, partial: sync.partial });
    return true;
  }

  private onCursor(session: Session, room: Room, member: Member, x: unknown, y: unknown, active: boolean): boolean {
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      return this.protocolError(session, 'bad_cursor', 'Cursor needs finite x/y.');
    }
    const now = member.lastSeen;
    if (now - member.cursorAt < CURSOR_MIN_INTERVAL_MS) return true;
    member.cursorAt = now;
    room.broadcast(
      { t: 'cursor', userId: member.user.id, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, active },
      member.user.id,
    );
    return true;
  }

  /**
   * Build a `sync` payload: a delta when the client is close behind, a full
   * snapshot when it would be cheaper (or when compaction means the delta can
   * no longer be reconstructed).
   */
  private buildSync(room: Room, since: number): SSync {
    const log = room.state.log;
    const canDelta = since > 0 && since <= log.seq && since >= log.truncatedBelowSeq;
    let ops: Op[];
    let partial: boolean;
    if (canDelta) {
      ops = log.opsSince(since);
      partial = true;
      if (log.size > 0 && ops.length > log.size * DELTA_MAX_SHARE) {
        ops = log.ops.slice();
        partial = false;
      }
    } else {
      ops = log.ops.slice();
      partial = false;
    }
    const out: SSync = { t: 'sync', ops, seq: log.seq, hv: log.hv, partial };
    if (partial) {
      // Visibility of ops older than `since` may have changed while away.
      out.undone = log.ops.filter((op) => op.undone).map((op) => op.id);
    }
    return out;
  }

  /** Tear down a session and tell the room. */
  disconnect(session: Session, reason: string): void {
    if (session.closed) return;
    session.closed = true;
    const room = session.room;
    const userId = session.userId;
    if (room === null || userId === null) return;

    // Only drop the member if this connection is still the live one for that
    // identity — otherwise a reconnect that already replaced us would be undone.
    if (room.members.get(userId)?.conn.id !== session.conn.id) {
      this.log('disconnect_stale', { room: room.id, userId, reason });
      return;
    }

    const abandoned = room.leave(userId);
    for (const sid of abandoned) {
      room.broadcast({ t: 'cancel', sid, userId });
    }
    room.broadcast({ t: 'leave', userId });
    this.log('leave', { room: room.id, userId, reason, users: room.size });
  }

  /**
   * Report a failure that a well-behaved client can legitimately hit — most of
   * all `no_stroke`, which happens whenever a stroke's messages arrive after the
   * server has dropped the pending stroke (a reconnect, or a stale window). It
   * must not count towards the abuse strikes.
   */
  private softFail(session: Session, code: string, message: string): boolean {
    if (code === 'no_stroke' || code === 'forbidden') {
      session.conn.send({ t: 'error', code, message });
      return false;
    }
    return this.protocolError(session, code, message);
  }

  private protocolError(session: Session, code: string, message: string): boolean {
    session.strikes++;
    session.conn.send({ t: 'error', code, message });
    if (session.strikes > 20) {
      this.fatal(session, 'too_many_errors', 'Too many protocol errors.');
    }
    return false;
  }

  /** Non-fatal, rate-limited feedback (e.g. "nothing to undo"). */
  private notice(session: Session, code: string, message: string): void {
    const now = Date.now();
    if (code === 'rate_limited' && now - session.lastNotice < RATE_NOTICE_INTERVAL_MS) return;
    session.lastNotice = now;
    session.conn.send({ t: 'error', code, message });
  }

  private fatal(session: Session, code: string, message: string): void {
    const msg: ServerMessage = { t: 'error', code, message, fatal: true };
    session.conn.send(msg);
    session.conn.close(code);
    this.disconnect(session, code);
  }
}

/** Hard cap on a single inbound frame (bytes). A 4000-point stroke fits easily. */
export const MAX_FRAME_BYTES = 96 * 1024;

/** Hard cap on messages inside one batched frame. */
export const MAX_BATCH_MESSAGES = 200;
