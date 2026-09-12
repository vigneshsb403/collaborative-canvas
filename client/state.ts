/**
 * Client-side mirror of the room.
 *
 * This module is deliberately pure bookkeeping: it takes a `ServerMessage` and
 * returns a list of *effects* describing the minimum work the renderer and the
 * UI must do. Nothing here touches the DOM or a canvas, which keeps the
 * "what changed" logic testable and the repaint strategy honest — if a message
 * only dirties one stroke's bounding box, that is all the renderer is told to
 * repaint.
 *
 * The visible picture is computed by the same `OpLog` class the server runs, so
 * client and server cannot disagree about what an undo means.
 */

import { OpLog } from '../shared/oplog.js';
import type { BBox, LiveStroke, Limits, Op, StrokeOp, User } from '../shared/protocol.js';
import { LIMITS } from '../shared/protocol.js';
import { strokeBBox, unionBBox } from '../shared/geometry.js';

export interface Cursor {
  x: number;
  y: number;
  active: boolean;
  /** Local timestamp of the last update, for idle fade-out. */
  at: number;
}

export type Effect =
  /** Rebuild the committed layer from scratch. */
  | { kind: 'repaintAll' }
  /** Rasterise one newly committed op onto the committed layer. */
  | { kind: 'commit'; op: StrokeOp; dirty: BBox }
  /** Re-rasterise just this region of the committed layer. */
  | { kind: 'region'; bbox: BBox }
  /** The set of in-flight strokes changed; `dirty` is the area affected. */
  | { kind: 'live'; dirty: BBox | null }
  | { kind: 'presence' }
  | { kind: 'cursors' }
  | { kind: 'identity' }
  | { kind: 'notice'; code: string; message: string; fatal: boolean }
  /** A history gap was detected; the caller should ask for a resync. */
  | { kind: 'gap'; expected: number; got: number };

export class ClientState {
  readonly log = new OpLog();
  readonly users = new Map<string, User>();
  readonly cursors = new Map<string, Cursor>();
  /** Strokes being drawn right now: other people's, plus our own unconfirmed ones. */
  readonly live = new Map<string, LiveStroke>();
  /** Our own strokes that have been sent but not yet acknowledged with a commit. */
  readonly ownPending = new Set<string>();

  self: User | null = null;
  limits: Limits = LIMITS;
  roomId = 'main';
  /** Server history version, used to detect a missed update. */
  serverHv = 0;

  get selfId(): string | null {
    return this.self?.id ?? null;
  }

  /** Highest committed seq we hold — what a reconnect asks to resume from. */
  get since(): number {
    return this.log.seq;
  }

  apply(msg: import('../shared/protocol.js').ServerMessage): Effect[] {
    switch (msg.t) {
      case 'welcome': {
        this.roomId = msg.room;
        this.self = msg.you;
        this.limits = msg.limits;
        this.users.clear();
        for (const u of msg.users) this.users.set(u.id, u);
        this.absorbSnapshot(msg.ops, msg.partial, msg.undone);
        this.serverHv = msg.hv;
        this.absorbLive(msg.live);
        return [{ kind: 'identity' }, { kind: 'presence' }, { kind: 'repaintAll' }, { kind: 'cursors' }];
      }

      case 'sync': {
        this.absorbSnapshot(msg.ops, msg.partial, msg.undone);
        this.serverHv = msg.hv;
        return [{ kind: 'repaintAll' }];
      }

      case 'join': {
        this.users.set(msg.user.id, msg.user);
        return [{ kind: 'presence' }];
      }

      case 'leave': {
        this.users.delete(msg.userId);
        this.cursors.delete(msg.userId);
        // Any stroke they were mid-way through is dropped by the server too.
        let dirty: BBox | null = null;
        for (const [sid, s] of this.live) {
          if (s.userId !== msg.userId) continue;
          dirty = mergeDirty(dirty, liveBBox(s));
          this.live.delete(sid);
        }
        return [{ kind: 'presence' }, { kind: 'cursors' }, { kind: 'live', dirty }];
      }

      case 'rename': {
        const user = this.users.get(msg.userId);
        if (user !== undefined) user.name = msg.name;
        if (this.self?.id === msg.userId) this.self.name = msg.name;
        return [{ kind: 'presence' }];
      }

      case 'begin': {
        const stroke: LiveStroke = { sid: msg.sid, userId: msg.userId, style: msg.style, pts: msg.pts.slice() };
        this.live.set(msg.sid, stroke);
        return [{ kind: 'live', dirty: liveBBox(stroke) }];
      }

      case 'points': {
        const stroke = this.live.get(msg.sid);
        if (stroke === undefined) return [];
        // Only the new segment is dirty — plus the two points before it, since
        // quadratic smoothing reshapes the join.
        const dirty = segmentBBox(stroke, msg.pts, stroke.style.width);
        for (const v of msg.pts) stroke.pts.push(v);
        return [{ kind: 'live', dirty }];
      }

      case 'commit': {
        const pending = this.live.get(msg.sid);
        this.live.delete(msg.sid);
        this.ownPending.delete(msg.sid);
        const gap = this.checkHv(msg.hv);
        if (this.log.has(msg.op.id)) {
          // Already applied (a replayed frame). Still clear the live remnant.
          return [...gap, { kind: 'live', dirty: pending === undefined ? null : liveBBox(pending) }];
        }
        this.log.append(msg.op);
        this.log.hv = msg.hv;
        // The canonical op may differ slightly from the prediction we drew, so
        // the dirty area must cover both.
        const dirty = pending === undefined ? msg.op.bbox : unionBBox(msg.op.bbox, liveBBox(pending));
        return [...gap, { kind: 'commit', op: msg.op, dirty }];
      }

      case 'cancel': {
        const stroke = this.live.get(msg.sid);
        if (stroke === undefined) return [];
        this.live.delete(msg.sid);
        this.ownPending.delete(msg.sid);
        return [{ kind: 'live', dirty: liveBBox(stroke) }];
      }

      case 'vis': {
        const gap = this.checkHv(msg.hv);
        if (msg.action === 'clear' && msg.op !== undefined) {
          this.log.append(msg.op);
          this.log.hv = msg.hv;
          return [...gap, { kind: 'repaintAll' }];
        }
        let dirty: BBox | null = null;
        let full = false;
        for (const change of msg.changes) {
          const op = this.log.get(change.id);
          if (op === undefined) {
            // We do not know this op — our log is behind; a resync will fix it.
            full = true;
            continue;
          }
          if (op.kind === 'clear') full = true;
          else dirty = mergeDirty(dirty, op.bbox);
          this.log.setUndone(change.id, change.undone);
        }
        this.log.hv = msg.hv;
        if (full) return [...gap, { kind: 'repaintAll' }];
        if (dirty === null) return gap;
        return [...gap, { kind: 'region', bbox: dirty }];
      }

      case 'cursor': {
        this.cursors.set(msg.userId, { x: msg.x, y: msg.y, active: msg.active, at: performance.now() });
        return [{ kind: 'cursors' }];
      }

      case 'error':
        return [{ kind: 'notice', code: msg.code, message: msg.message, fatal: msg.fatal === true }];

      case 'pong':
      case 'reconnect':
        return [];

      default:
        return [];
    }
  }

  /* ---------------------------------------------------------------- */
  /* Local (optimistic) stroke handling                                */
  /* ---------------------------------------------------------------- */

  /** Register a stroke we are drawing ourselves, rendered before the server sees it. */
  addOwnLive(stroke: LiveStroke): void {
    this.live.set(stroke.sid, stroke);
    this.ownPending.add(stroke.sid);
  }

  removeOwnLive(sid: string): LiveStroke | undefined {
    const stroke = this.live.get(sid);
    this.live.delete(sid);
    this.ownPending.delete(sid);
    return stroke;
  }

  /** Our own strokes still awaiting a commit, oldest first. */
  unconfirmed(): LiveStroke[] {
    const out: LiveStroke[] = [];
    for (const sid of this.ownPending) {
      const s = this.live.get(sid);
      if (s !== undefined) out.push(s);
    }
    return out;
  }

  userColor(userId: string): string {
    return this.users.get(userId)?.color ?? '#8b8b8b';
  }

  userName(userId: string): string {
    return this.users.get(userId)?.name ?? 'Someone';
  }

  /* ---------------------------------------------------------------- */

  private absorbSnapshot(ops: Op[], partial: boolean, undone: string[] | undefined): void {
    if (!partial) {
      this.log.reset();
    }
    for (const op of ops) {
      if (this.log.has(op.id)) continue;
      this.log.append(op);
    }
    if (partial && undone !== undefined) {
      // Visibility of ops older than our resume point may have changed while we
      // were disconnected; the server sends the authoritative set.
      const undoneSet = new Set(undone);
      for (const op of this.log.ops) {
        this.log.setUndone(op.id, undoneSet.has(op.id));
      }
    }
  }

  private absorbLive(live: LiveStroke[]): void {
    // Keep our own unconfirmed strokes; replace everyone else's.
    for (const sid of [...this.live.keys()]) {
      if (!this.ownPending.has(sid)) this.live.delete(sid);
    }
    for (const s of live) this.live.set(s.sid, { ...s, pts: s.pts.slice() });
  }

  /**
   * Every server action that changes history bumps `hv` by exactly one and
   * broadcasts it, so a jump means we missed a message and must resync.
   */
  private checkHv(hv: number): Effect[] {
    const expected = this.serverHv + 1;
    this.serverHv = hv;
    if (hv > expected) return [{ kind: 'gap', expected, got: hv }];
    return [];
  }
}

/* ------------------------------------------------------------------ */

export function liveBBox(stroke: LiveStroke): BBox {
  return strokeBBox(stroke.pts, stroke.style.width);
}

/**
 * Bounds of the newly appended tail of a live stroke, including the last two
 * existing points because quadratic smoothing rewrites the join.
 */
function segmentBBox(stroke: LiveStroke, added: number[], width: number): BBox {
  const tail: number[] = [];
  const start = Math.max(0, stroke.pts.length - 4);
  for (let i = start; i < stroke.pts.length; i++) tail.push(stroke.pts[i]!);
  return strokeBBox(tail.concat(added), width);
}

function mergeDirty(a: BBox | null, b: BBox): BBox {
  return a === null ? b : unionBBox(a, b);
}
