/**
 * The operation log: the single source of truth for what is on the canvas.
 *
 * Both the server (authoritative) and the browser (a passive mirror fed by
 * `commit` / `vis` messages) run this exact class, so "is this stroke visible?"
 * is answered by the same code on both ends. That is what keeps a client from
 * drifting after an undo it did not initiate.
 *
 * Visibility rule (total, order-independent, derived — never stored):
 *
 *     visible(stroke) = !stroke.undone && stroke.seq > activeClearSeq
 *     visible(clear)  = n/a (a clear draws nothing, it only hides)
 *
 * where `activeClearSeq` is the sequence number of the highest non-undone
 * `clear` op. Because visibility is a pure function of the log, two clients
 * that have received the same set of messages *cannot* disagree about the
 * picture, regardless of the order the messages arrived in.
 */

import type { ClearOp, Op, StrokeOp } from './protocol.js';

export class OpLog {
  /** Ops in ascending `seq` order. Append-only; never spliced except by compact(). */
  readonly ops: Op[] = [];
  private readonly index = new Map<string, Op>();
  private readonly clears: ClearOp[] = [];

  /** Highest `seq` seen. */
  seq = 0;
  /** History version: bumped on every visibility change. Detects missed updates. */
  hv = 0;
  /** `seq` of the newest active clear; 0 when nothing is cleared. */
  activeClearSeq = 0;
  /** Ops before this seq have been dropped by compaction and can never return. */
  truncatedBelowSeq = 0;

  get size(): number {
    return this.ops.length;
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  get(id: string): Op | undefined {
    return this.index.get(id);
  }

  /**
   * Append an op. Ops normally arrive in `seq` order; an out-of-order arrival
   * (possible on the client if a `commit` overtakes a `vis`) is inserted at the
   * right position so rendering order stays stable.
   */
  append(op: Op): void {
    if (this.index.has(op.id)) return;
    this.index.set(op.id, op);

    const last = this.ops[this.ops.length - 1];
    if (last === undefined || last.seq < op.seq) {
      this.ops.push(op);
    } else {
      let lo = 0;
      let hi = this.ops.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.ops[mid]!.seq < op.seq) lo = mid + 1;
        else hi = mid;
      }
      this.ops.splice(lo, 0, op);
    }

    if (op.kind === 'clear') {
      this.clears.push(op);
      this.clears.sort((a, b) => a.seq - b.seq);
      this.recomputeActiveClear();
    }
    if (op.seq > this.seq) this.seq = op.seq;
  }

  /** Toggle an op's undone flag. Returns true if anything actually changed. */
  setUndone(id: string, undone: boolean): boolean {
    const op = this.index.get(id);
    if (op === undefined || op.undone === undone) return false;
    op.undone = undone;
    if (op.kind === 'clear') this.recomputeActiveClear();
    this.hv++;
    return true;
  }

  isVisible(op: Op): boolean {
    if (op.kind !== 'stroke') return false;
    return !op.undone && op.seq > this.activeClearSeq;
  }

  /** Strokes that should be painted, in paint order. */
  visibleStrokes(): StrokeOp[] {
    const out: StrokeOp[] = [];
    for (const op of this.ops) {
      if (op.kind === 'stroke' && !op.undone && op.seq > this.activeClearSeq) out.push(op);
    }
    return out;
  }

  /** Ops with `seq > since`, for delta sync after a reconnect. */
  opsSince(since: number): Op[] {
    if (since <= 0) return this.ops.slice();
    let lo = 0;
    let hi = this.ops.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ops[mid]!.seq <= since) lo = mid + 1;
      else hi = mid;
    }
    return this.ops.slice(lo);
  }

  /**
   * Drop every op at or below `beforeSeq`. Only ever called for ops that are
   * permanently hidden behind an active clear, so no pixel can change.
   * Returns the ids that were removed so undo stacks can be pruned.
   */
  compactBelow(beforeSeq: number): string[] {
    const removed: string[] = [];
    let i = 0;
    while (i < this.ops.length && this.ops[i]!.seq <= beforeSeq) {
      const op = this.ops[i]!;
      removed.push(op.id);
      this.index.delete(op.id);
      i++;
    }
    if (i > 0) {
      this.ops.splice(0, i);
      for (let k = this.clears.length - 1; k >= 0; k--) {
        if (this.clears[k]!.seq <= beforeSeq) this.clears.splice(k, 1);
      }
      this.truncatedBelowSeq = beforeSeq;
      this.recomputeActiveClear();
    }
    return removed;
  }

  /** Total number of stored points — the real memory driver for a room. */
  pointCount(): number {
    let n = 0;
    for (const op of this.ops) {
      if (op.kind === 'stroke') n += op.pts.length >> 1;
    }
    return n;
  }

  private recomputeActiveClear(): void {
    let max = 0;
    for (const c of this.clears) {
      if (!c.undone && c.seq > max) max = c.seq;
    }
    this.activeClearSeq = max;
  }
}
