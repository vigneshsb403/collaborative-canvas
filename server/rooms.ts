/**
 * Room management: presence, identity and lifecycle.
 *
 * A "room" is an independent canvas keyed by a slug from the URL
 * (`/?room=studio`). Rooms are created lazily and garbage-collected a while
 * after the last participant leaves, so a refresh or a dropped connection does
 * not wipe the drawing.
 *
 * Identity is a client-generated, locally persisted `clientId` (localStorage).
 * That is what lets a reconnecting browser keep its colour, display name and
 * personal undo stack. There is no authentication — see README § Known
 * limitations.
 */

import type { LiveStroke, ServerMessage, User } from '../shared/protocol.js';
import { USER_COLORS, colorForIndex, nameForIndex } from '../shared/protocol.js';
import { DrawingState } from './drawing-state.js';

/** Transport-agnostic view of one connected peer (WebSocket or SSE stream). */
export interface Connection {
  readonly id: string;
  send(msg: ServerMessage): void;
  close(reason?: string): void;
  /** Transport label, for logging: 'ws' | 'sse'. */
  readonly kind: string;
}

export interface Member {
  user: User;
  colorIndex: number;
  conn: Connection;
  joinedAt: number;
  lastSeen: number;
  cursorAt: number;
  /** Token-bucket balance, used by the rate limiter. */
  tokens: number;
  tokensAt: number;
}

/** Identity kept for a while after a user leaves, so reconnects are seamless. */
interface ParkedIdentity {
  user: User;
  colorIndex: number;
  leftAt: number;
}

export const USER_ID_RE = /^[A-Za-z0-9_-]{6,48}$/;

export const IDENTITY_TTL_MS = 10 * 60 * 1000;
export const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;

export class Room {
  readonly state = new DrawingState();
  readonly members = new Map<string, Member>();
  private readonly parked = new Map<string, ParkedIdentity>();
  private readonly usedColors = new Set<number>();
  private colorCursor = 0;
  private nameCursor = 0;
  lastActivity = Date.now();

  constructor(readonly id: string) {}

  get size(): number {
    return this.members.size;
  }

  users(): User[] {
    return [...this.members.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((m) => m.user);
  }

  /**
   * Admit a connection. If the same user id is already present (second tab, or
   * a reconnect the server has not noticed yet) the older connection is evicted
   * so presence never shows phantom duplicates.
   */
  join(userId: string, conn: Connection, requestedName?: string): { member: Member; replaced: Connection | null } {
    const existing = this.members.get(userId);
    let replaced: Connection | null = null;
    if (existing !== undefined) {
      replaced = existing.conn;
      this.usedColors.delete(existing.colorIndex);
      this.members.delete(userId);
    }

    const parked = this.parked.get(userId);
    this.parked.delete(userId);

    const remembered = parked?.colorIndex ?? existing?.colorIndex;
    const colorIndex = remembered !== undefined && !this.usedColors.has(remembered)
      ? remembered
      : this.takeColorIndex();
    this.usedColors.add(colorIndex);

    const name = sanitizeName(requestedName)
      ?? parked?.user.name
      ?? existing?.user.name
      ?? nameForIndex(this.nameCursor++);

    const now = Date.now();
    const member: Member = {
      user: { id: userId, name, color: colorForIndex(colorIndex) },
      colorIndex,
      conn,
      joinedAt: existing?.joinedAt ?? parked?.leftAt ?? now,
      lastSeen: now,
      cursorAt: 0,
      tokens: RATE_BURST,
      tokensAt: now,
    };
    this.members.set(userId, member);
    this.lastActivity = now;
    return { member, replaced };
  }

  /** Remove a member; returns the stroke ids that were abandoned mid-draw. */
  leave(userId: string): string[] {
    const member = this.members.get(userId);
    if (member === undefined) return [];
    this.members.delete(userId);
    this.usedColors.delete(member.colorIndex);
    this.parked.set(userId, { user: member.user, colorIndex: member.colorIndex, leftAt: Date.now() });
    this.lastActivity = Date.now();
    return this.state.dropUser(userId);
  }

  rename(userId: string, raw: string): string | null {
    const member = this.members.get(userId);
    if (member === undefined) return null;
    const name = sanitizeName(raw);
    if (name === null) return null;
    member.user.name = name;
    this.lastActivity = Date.now();
    return name;
  }

  broadcast(msg: ServerMessage, exceptUserId?: string): void {
    for (const [id, member] of this.members) {
      if (id === exceptUserId) continue;
      member.conn.send(msg);
    }
  }

  sendTo(userId: string, msg: ServerMessage): void {
    this.members.get(userId)?.conn.send(msg);
  }

  liveStrokesFor(userId: string): LiveStroke[] {
    return this.state.liveStrokes(userId);
  }

  /** Drop parked identities that have aged out. */
  sweep(now = Date.now()): void {
    for (const [id, p] of this.parked) {
      if (now - p.leftAt > IDENTITY_TTL_MS) this.parked.delete(id);
    }
  }

  private takeColorIndex(): number {
    for (let i = 0; i < USER_COLORS.length; i++) {
      const candidate = (this.colorCursor + i) % USER_COLORS.length;
      if (!this.usedColors.has(candidate)) {
        this.colorCursor = (candidate + 1) % USER_COLORS.length;
        return candidate;
      }
    }
    const fallback = this.colorCursor;
    this.colorCursor = (this.colorCursor + 1) % USER_COLORS.length;
    return fallback;
  }
}

/** Token-bucket parameters, per member. Generous enough for a 120Hz pointer. */
export const RATE_BURST = 240;
export const RATE_REFILL_PER_SEC = 160;

/** Returns false when the member is over budget and the message must be dropped. */
export function consumeToken(member: Member, cost = 1, now = Date.now()): boolean {
  const elapsed = (now - member.tokensAt) / 1000;
  if (elapsed > 0) {
    member.tokens = Math.min(RATE_BURST, member.tokens + elapsed * RATE_REFILL_PER_SEC);
    member.tokensAt = now;
  }
  if (member.tokens < cost) return false;
  member.tokens -= cost;
  return true;
}

const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g');

export function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, 24);
}

export function sanitizeRoomId(raw: unknown): string {
  if (typeof raw !== 'string') return 'main';
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return cleaned.length === 0 ? 'main' : cleaned.slice(0, 40);
}

export function sanitizeUserId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return USER_ID_RE.test(raw) ? raw : null;
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  get(id: string): Room {
    let room = this.rooms.get(id);
    if (room === undefined) {
      room = new Room(id);
      this.rooms.set(id, room);
    }
    return room;
  }

  peek(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  /**
   * Lazy GC: driven by a timer in the long-lived server, and called on every
   * request in the serverless runtime where timers are not guaranteed to fire.
   */
  sweep(now = Date.now()): void {
    for (const [id, room] of this.rooms) {
      room.sweep(now);
      if (room.size === 0 && now - room.lastActivity > EMPTY_ROOM_TTL_MS) {
        this.rooms.delete(id);
      }
    }
  }

  stats(): { rooms: number; users: number; ops: number } {
    let users = 0;
    let ops = 0;
    for (const room of this.rooms.values()) {
      users += room.size;
      ops += room.state.log.size;
    }
    return { rooms: this.rooms.size, users, ops };
  }
}
