/**
 * Authoritative canvas state for one room.
 *
 * Responsibilities
 * ----------------
 * 1. Hold the append-only op log (via the shared `OpLog`).
 * 2. Own the *total order*: `seq` is handed out here and nowhere else. Every
 *    conflict in this system is resolved by "the server decided the order".
 * 3. Track strokes that are in flight (streaming) and canonicalise them on end.
 * 4. Maintain the undo/redo stacks — global (linear, room-wide) and per user.
 * 5. Enforce resource limits so one client cannot exhaust room memory.
 *
 * Undo/redo model
 * ---------------
 * Ops are never deleted; undo flips a tombstone flag. Two stacks exist per
 * scope, and stack entries are *lazily validated* on pop: an entry is only
 * actionable if the op's current state still matches what the stack implies
 * (an undo candidate must currently be visible, a redo candidate must currently
 * be hidden *and* become visible when restored). That single rule is what makes
 * concurrent undo safe — if two users undo at the same instant, the server
 * serialises them, the first wins the op, and the second's stack entry is
 * skipped as stale and it moves on to the next candidate instead of producing a
 * no-op or a double-undo.
 *
 * See ARCHITECTURE.md § "Undo/Redo Strategy" for the full rationale.
 */

import type { ClearOp, LiveStroke, Op, StrokeOp, StrokeStyle, UndoScope } from '../shared/protocol.js';
import { LIMITS } from '../shared/protocol.js';
import { OpLog } from '../shared/oplog.js';
import { appendPoints, sanitizePoints, sanitizeStyle, simplify, strokeBBox } from '../shared/geometry.js';

export type Result<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

const fail = (code: string, message: string): Result<never> => ({ ok: false, code, message });
const done = <T>(value: T): Result<T> => ({ ok: true, value });

export interface VisibilityChange {
  id: string;
  undone: boolean;
}

export interface UndoOutcome {
  changes: VisibilityChange[];
  hv: number;
}

export interface StateLimits {
  maxOpsPerRoom: number;
  maxPointsPerRoom: number;
  maxLiveStrokesPerUser: number;
  maxPointsPerStroke: number;
  maxUndoStack: number;
}

export const DEFAULT_STATE_LIMITS: StateLimits = {
  maxOpsPerRoom: LIMITS.maxOpsPerRoom,
  maxPointsPerRoom: 300_000,
  maxLiveStrokesPerUser: 4,
  maxPointsPerStroke: LIMITS.maxPointsPerStroke,
  maxUndoStack: 4000,
};

interface PendingStroke {
  sid: string;
  userId: string;
  style: StrokeStyle;
  /** Raw accumulated points (deduped, quantised) — canonicalised on end. */
  pts: number[];
  startedAt: number;
}

interface UserStacks {
  undo: string[];
  redo: string[];
}

const SID_RE = /^[A-Za-z0-9_:-]{1,80}$/;

export class DrawingState {
  readonly log = new OpLog();
  private readonly pending = new Map<string, PendingStroke>();
  private readonly pendingByUser = new Map<string, Set<string>>();
  private readonly globalStacks: UserStacks = { undo: [], redo: [] };
  private readonly userStacks = new Map<string, UserStacks>();
  private opCounter = 0;

  constructor(private readonly limits: StateLimits = DEFAULT_STATE_LIMITS) {}

  /* ---------------------------------------------------------------- */
  /* Streaming strokes                                                 */
  /* ---------------------------------------------------------------- */

  beginStroke(userId: string, sid: unknown, rawStyle: unknown, rawPts: unknown): Result<PendingStroke> {
    if (typeof sid !== 'string' || !SID_RE.test(sid)) {
      return fail('bad_sid', 'Stroke id must match /^[A-Za-z0-9_:-]{1,80}$/.');
    }
    // Namespacing sids by user id makes cross-user id collisions impossible
    // without trusting the client about authorship.
    if (!sid.startsWith(`${userId}-`)) {
      return fail('bad_sid', 'Stroke id must be prefixed with your user id.');
    }
    if (this.pending.has(sid) || this.log.has(sid)) {
      return fail('dup_sid', 'Stroke id already used.');
    }

    const mine = this.pendingByUser.get(userId);
    if (mine !== undefined && mine.size >= this.limits.maxLiveStrokesPerUser) {
      return fail('too_many_live', 'Too many concurrent strokes.');
    }

    const style = sanitizeStyle(rawStyle);
    if (style === null) return fail('bad_style', 'Invalid stroke style.');

    const first = sanitizePoints(rawPts, this.limits.maxPointsPerStroke);
    if (first === null) return fail('bad_points', 'Invalid point list.');

    const capacity = this.capacityCheck();
    if (!capacity.ok) return capacity;

    const stroke: PendingStroke = { sid, userId, style, pts: [], startedAt: Date.now() };
    appendPoints(stroke.pts, first);
    this.pending.set(sid, stroke);
    if (mine === undefined) this.pendingByUser.set(userId, new Set([sid]));
    else mine.add(sid);
    return done(stroke);
  }

  /**
   * Append a streamed batch. Returns the points that were actually kept, which
   * is what gets rebroadcast — dropping near-duplicate points here shrinks the
   * fan-out traffic as well as the stored stroke.
   */
  addPoints(userId: string, sid: unknown, rawPts: unknown): Result<number[]> {
    if (typeof sid !== 'string') return fail('bad_sid', 'Invalid stroke id.');
    const stroke = this.pending.get(sid);
    if (stroke === undefined) return fail('no_stroke', 'Unknown stroke id.');
    if (stroke.userId !== userId) return fail('forbidden', 'Not your stroke.');

    const pts = sanitizePoints(rawPts, this.limits.maxPointsPerStroke);
    if (pts === null) return fail('bad_points', 'Invalid point list.');

    const room = this.limits.maxPointsPerStroke - (stroke.pts.length >> 1);
    if (room <= 0) return done([]);

    const before = stroke.pts.length;
    appendPoints(stroke.pts, pts.slice(0, room * 2));
    return done(stroke.pts.slice(before));
  }

  /**
   * Finalise a stroke: simplify the raw path, assign the authoritative `seq`
   * and commit it to the log.
   *
   * `clientPointCount` is the number of raw points the client believes it
   * streamed. A mismatch means the two sides accumulated different input, so
   * the caller can flag it; the committed op is authoritative either way and
   * the client reconciles against it.
   */
  endStroke(userId: string, sid: unknown, clientPointCount?: number): Result<{ op: StrokeOp; desync: boolean }> {
    if (typeof sid !== 'string') return fail('bad_sid', 'Invalid stroke id.');
    const stroke = this.pending.get(sid);
    if (stroke === undefined) return fail('no_stroke', 'Unknown stroke id.');
    if (stroke.userId !== userId) return fail('forbidden', 'Not your stroke.');

    this.forgetPending(stroke);

    if (stroke.pts.length === 0) return fail('empty_stroke', 'Stroke had no points.');

    const desync = typeof clientPointCount === 'number' && clientPointCount !== stroke.pts.length >> 1;

    const pts = simplify(stroke.pts);
    const op: StrokeOp = {
      kind: 'stroke',
      id: sid,
      seq: ++this.opCounter,
      userId,
      ts: Date.now(),
      style: stroke.style,
      pts,
      bbox: strokeBBox(pts, stroke.style.width),
      undone: false,
    };
    this.commit(op);
    return done({ op, desync });
  }

  cancelStroke(userId: string, sid: unknown): Result<string> {
    if (typeof sid !== 'string') return fail('bad_sid', 'Invalid stroke id.');
    const stroke = this.pending.get(sid);
    if (stroke === undefined) return fail('no_stroke', 'Unknown stroke id.');
    if (stroke.userId !== userId) return fail('forbidden', 'Not your stroke.');
    this.forgetPending(stroke);
    return done(sid);
  }

  /** Abandon every in-flight stroke for a user (called on disconnect). */
  dropUser(userId: string): string[] {
    const sids = this.pendingByUser.get(userId);
    if (sids === undefined) return [];
    const list = [...sids];
    for (const sid of list) this.pending.delete(sid);
    this.pendingByUser.delete(userId);
    return list;
  }

  liveStrokes(excludeUserId?: string): LiveStroke[] {
    const out: LiveStroke[] = [];
    for (const s of this.pending.values()) {
      if (s.userId === excludeUserId) continue;
      out.push({ sid: s.sid, userId: s.userId, style: s.style, pts: s.pts.slice() });
    }
    return out;
  }

  getPending(sid: string): LiveStroke | undefined {
    const s = this.pending.get(sid);
    if (s === undefined) return undefined;
    return { sid: s.sid, userId: s.userId, style: s.style, pts: s.pts.slice() };
  }

  /* ---------------------------------------------------------------- */
  /* Clear                                                             */
  /* ---------------------------------------------------------------- */

  /** A clear is a normal, undoable op that hides everything before it. */
  clear(userId: string): Result<ClearOp> {
    if (this.log.visibleStrokes().length === 0) {
      return fail('already_clear', 'Canvas is already empty.');
    }
    const seq = ++this.opCounter;
    const op: ClearOp = {
      kind: 'clear',
      id: `${userId}-clr-${seq}`,
      seq,
      userId,
      ts: Date.now(),
      undone: false,
    };
    this.commit(op);
    return done(op);
  }

  /* ---------------------------------------------------------------- */
  /* Undo / redo                                                       */
  /* ---------------------------------------------------------------- */

  undo(userId: string, scope: UndoScope): Result<UndoOutcome> {
    const stack = this.stacksFor(scope, userId).undo;
    while (stack.length > 0) {
      const id = stack.pop()!;
      const op = this.log.get(id);
      // Stale entry: op was compacted away, or somebody already undid it.
      if (op === undefined || op.undone) continue;
      // A stroke already hidden behind an active clear would change no pixels.
      if (op.kind === 'stroke' && !this.log.isVisible(op)) continue;

      this.log.setUndone(id, true);
      this.pushRedo(op);
      return done({ changes: [{ id, undone: true }], hv: this.log.hv });
    }
    return fail('nothing_to_undo', scope === 'mine' ? 'You have nothing to undo.' : 'Nothing to undo.');
  }

  redo(userId: string, scope: UndoScope): Result<UndoOutcome> {
    const stack = this.stacksFor(scope, userId).redo;
    while (stack.length > 0) {
      const id = stack.pop()!;
      const op = this.log.get(id);
      if (op === undefined || !op.undone) continue;
      // Restoring this stroke would still leave it hidden behind a clear.
      if (op.kind === 'stroke' && op.seq <= this.log.activeClearSeq) continue;

      this.log.setUndone(id, false);
      this.pushUndo(op);
      return done({ changes: [{ id, undone: false }], hv: this.log.hv });
    }
    return fail('nothing_to_redo', scope === 'mine' ? 'You have nothing to redo.' : 'Nothing to redo.');
  }

  /** What the UI should enable, evaluated without mutating anything. */
  canUndo(userId: string, scope: UndoScope): boolean {
    const stack = this.stacksFor(scope, userId).undo;
    for (let i = stack.length - 1; i >= 0; i--) {
      const op = this.log.get(stack[i]!);
      if (op === undefined || op.undone) continue;
      if (op.kind === 'stroke' && !this.log.isVisible(op)) continue;
      return true;
    }
    return false;
  }

  canRedo(userId: string, scope: UndoScope): boolean {
    const stack = this.stacksFor(scope, userId).redo;
    for (let i = stack.length - 1; i >= 0; i--) {
      const op = this.log.get(stack[i]!);
      if (op === undefined || !op.undone) continue;
      if (op.kind === 'stroke' && op.seq <= this.log.activeClearSeq) continue;
      return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  private commit(op: Op): void {
    this.log.append(op);
    this.log.hv++;
    this.pushUndo(op);
    // A new op truncates the room-wide redo branch (linear history) and the
    // author's own redo branch, but deliberately leaves *other* users' personal
    // redo stacks intact: their "redo mine" still refers to their own work.
    this.globalStacks.redo.length = 0;
    this.stacksFor('mine', op.userId).redo.length = 0;
    this.maybeCompact();
  }

  private pushUndo(op: Op): void {
    push(this.globalStacks.undo, op.id, this.limits.maxUndoStack);
    push(this.stacksFor('mine', op.userId).undo, op.id, this.limits.maxUndoStack);
  }

  private pushRedo(op: Op): void {
    push(this.globalStacks.redo, op.id, this.limits.maxUndoStack);
    push(this.stacksFor('mine', op.userId).redo, op.id, this.limits.maxUndoStack);
  }

  private stacksFor(scope: UndoScope, userId: string): UserStacks {
    if (scope === 'global') return this.globalStacks;
    let s = this.userStacks.get(userId);
    if (s === undefined) {
      s = { undo: [], redo: [] };
      this.userStacks.set(userId, s);
    }
    return s;
  }

  private forgetPending(stroke: PendingStroke): void {
    this.pending.delete(stroke.sid);
    const mine = this.pendingByUser.get(stroke.userId);
    if (mine !== undefined) {
      mine.delete(stroke.sid);
      if (mine.size === 0) this.pendingByUser.delete(stroke.userId);
    }
  }

  private capacityCheck(): Result<true> {
    if (this.log.size >= this.limits.maxOpsPerRoom) {
      return fail('room_full', `Room history limit reached (${this.limits.maxOpsPerRoom} ops). Clear the canvas to continue.`);
    }
    if (this.log.pointCount() >= this.limits.maxPointsPerRoom) {
      return fail('room_full', 'Room point budget exhausted. Clear the canvas to continue.');
    }
    return done(true);
  }

  /**
   * When the log outgrows its budget, drop ops that sit behind an active clear.
   * They are invisible and can only ever return by undoing past that clear, so
   * this trades "undo history older than the last clear" for unbounded memory.
   * Nothing that is on screen, or could be brought back without undoing the
   * clear itself, is ever removed.
   */
  private maybeCompact(): void {
    if (this.log.size <= this.limits.maxOpsPerRoom * 0.9) return;
    const cut = this.log.activeClearSeq;
    if (cut <= 0) return;
    const removed = new Set(this.log.compactBelow(cut));
    if (removed.size === 0) return;
    const prune = (stack: string[]) => {
      let w = 0;
      for (let i = 0; i < stack.length; i++) {
        const id = stack[i]!;
        if (!removed.has(id)) stack[w++] = id;
      }
      stack.length = w;
    };
    prune(this.globalStacks.undo);
    prune(this.globalStacks.redo);
    for (const s of this.userStacks.values()) {
      prune(s.undo);
      prune(s.redo);
    }
  }
}

function push(stack: string[], id: string, max: number): void {
  stack.push(id);
  if (stack.length > max) stack.splice(0, stack.length - max);
}
