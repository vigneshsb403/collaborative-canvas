/**
 * Pointer input -> stroke capture.
 *
 * High-frequency input is handled in three ways:
 *
 *  1. `getCoalescedEvents()` recovers the samples the browser merged into one
 *     `pointermove`. A 120Hz trackpad or pen delivers 8-10 real samples per
 *     frame; without this the stroke visibly loses detail on fast movement.
 *  2. Samples closer than MIN_POINT_DISTANCE are dropped immediately, at the
 *     source — the same rule the server applies, so both sides accumulate the
 *     identical raw path.
 *  3. Points are accumulated locally and emitted at most every
 *     POINTS_FLUSH_MS (30Hz), which is smooth to watch and a third of the
 *     traffic of forwarding every sample.
 *
 * Strokes render locally the instant they are drawn (client-side prediction) and
 * stay on the live layer until the server's `commit` arrives, at which point the
 * canonical op replaces the prediction. Nothing needs rolling back: the local
 * drawing is provisional until then, and the reconciliation is a repaint of one
 * bounding box.
 */

import { appendPoints, clamp } from '../shared/geometry.js';
import type { BBox, ClientMessage, StrokeStyle, Tool } from '../shared/protocol.js';
import { WORLD_H, WORLD_W, quantize } from '../shared/protocol.js';
import { sessionNonce } from './config.js';
import type { ClientState } from './state.js';

/** Outgoing point batches per second: 1000/33 ≈ 30. */
const POINTS_FLUSH_MS = 33;
/** Cursor updates are cheaper and less critical; 20Hz is plenty. */
const CURSOR_FLUSH_MS = 50;
/** Don't bother telling anyone about sub-pixel cursor moves. */
const CURSOR_MIN_DELTA = 0.6;

export interface DrawingHooks {
  send(msg: ClientMessage): void;
  sendNow(msg: ClientMessage): void;
  /** Mark a world-space region as needing a repaint. */
  dirty(box: BBox): void;
  /** The local brush cursor moved or changed. */
  overlayDirty(): void;
  /** Called when tool/colour/width changed, so the UI can re-render. */
  styleChanged(): void;
}

interface ActiveStroke {
  sid: string;
  pointerId: number;
  style: StrokeStyle;
  /** Every point we have kept, including those already sent. */
  pts: number[];
  /** Points captured but not yet transmitted. */
  outbox: number[];
  lastFlush: number;
}

export class DrawingController {
  tool: Tool = 'brush';
  color = '#1f2430';
  brushWidth = 6;
  eraserWidth = 28;

  /** Where the local pointer is, in world units; null when it is off-canvas. */
  localCursor: { x: number; y: number } | null = null;

  private readonly active = new Map<number, ActiveStroke>();
  private strokeCounter = 0;
  private rect: DOMRect;
  private lastCursorSent = 0;
  private lastCursorPos: { x: number; y: number } | null = null;
  private disposers: (() => void)[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly state: ClientState,
    private readonly hooks: DrawingHooks,
  ) {
    this.rect = canvas.getBoundingClientRect();
    this.attach();
  }

  get style(): StrokeStyle {
    return {
      color: this.color,
      width: this.tool === 'eraser' ? this.eraserWidth : this.brushWidth,
      tool: this.tool,
    };
  }

  get width(): number {
    return this.tool === 'eraser' ? this.eraserWidth : this.brushWidth;
  }

  get isDrawing(): boolean {
    return this.active.size > 0;
  }

  setTool(tool: Tool): void {
    if (this.tool === tool) return;
    this.tool = tool;
    this.hooks.styleChanged();
    this.hooks.overlayDirty();
  }

  setColor(color: string): void {
    if (this.color === color) return;
    this.color = color;
    // Choosing a colour implies you want to paint with it.
    this.tool = 'brush';
    this.hooks.styleChanged();
    this.hooks.overlayDirty();
  }

  setWidth(width: number): void {
    const w = clamp(Math.round(width), this.state.limits.minStrokeWidth, this.state.limits.maxStrokeWidth);
    if (this.tool === 'eraser') this.eraserWidth = w;
    else this.brushWidth = w;
    this.hooks.styleChanged();
    this.hooks.overlayDirty();
  }

  /** Re-read the canvas box; call after any layout change. */
  syncRect(): void {
    this.rect = this.canvas.getBoundingClientRect();
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers = [];
  }

  /* ---------------------------------------------------------------- */
  /* Frame tick                                                        */
  /* ---------------------------------------------------------------- */

  /** Called once per animation frame: emit accumulated points. */
  tick(now: number): void {
    for (const stroke of this.active.values()) {
      if (stroke.outbox.length === 0) continue;
      if (now - stroke.lastFlush < POINTS_FLUSH_MS) continue;
      this.flush(stroke);
    }
  }

  /**
   * Re-issue every in-progress stroke after a reconnect. The server never saw
   * the original `begin`, so the stroke restarts under a fresh id carrying every
   * point captured so far — the drawing continues without a visible break.
   */
  restartActiveStrokes(): void {
    if (this.active.size === 0) return;
    const restarted: ActiveStroke[] = [];
    for (const stroke of this.active.values()) {
      this.state.removeOwnLive(stroke.sid);
      stroke.sid = this.nextStrokeId();
      stroke.outbox = [];
      stroke.lastFlush = 0;
      restarted.push(stroke);
    }
    for (const stroke of restarted) {
      this.state.addOwnLive({
        sid: stroke.sid,
        userId: this.state.selfId ?? 'me',
        style: stroke.style,
        pts: stroke.pts,
      });
      this.hooks.sendNow({ t: 'begin', sid: stroke.sid, style: stroke.style, pts: stroke.pts.slice() });
    }
  }

  /** Abort every in-progress stroke (Escape, or a fatal error). */
  cancelAll(): void {
    for (const stroke of [...this.active.values()]) this.finish(stroke, 'cancel');
  }

  /* ---------------------------------------------------------------- */
  /* Event wiring                                                      */
  /* ---------------------------------------------------------------- */

  private attach(): void {
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window,
      type: K | string,
      handler: (ev: Event) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, handler as EventListener, opts);
      this.disposers.push(() => target.removeEventListener(type, handler as EventListener, opts));
    };

    on(this.canvas, 'pointerdown', (ev) => this.onPointerDown(ev as PointerEvent));
    on(this.canvas, 'pointermove', (ev) => this.onPointerMove(ev as PointerEvent));
    on(this.canvas, 'pointerup', (ev) => this.onPointerUp(ev as PointerEvent, 'end'));
    on(this.canvas, 'pointercancel', (ev) => this.onPointerUp(ev as PointerEvent, 'cancel'));
    on(this.canvas, 'pointerleave', (ev) => this.onPointerLeave(ev as PointerEvent));
    // The browser would otherwise show a text caret / start a drag.
    on(this.canvas, 'dragstart', (ev) => ev.preventDefault());
    on(this.canvas, 'contextmenu', (ev) => ev.preventDefault());
    on(window, 'scroll', () => this.syncRect(), { passive: true } as AddEventListenerOptions);
  }

  private onPointerDown(ev: PointerEvent): void {
    // Only the primary button draws; other buttons stay free for the browser.
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (this.active.has(ev.pointerId)) return;
    if (this.state.selfId === null) return;

    ev.preventDefault();
    this.syncRect();
    try {
      this.canvas.setPointerCapture(ev.pointerId);
    } catch {
      /* capture is best-effort */
    }

    const p = this.toWorld(ev.clientX, ev.clientY);
    const style = this.style;
    const stroke: ActiveStroke = {
      sid: this.nextStrokeId(),
      pointerId: ev.pointerId,
      style,
      pts: [p.x, p.y],
      outbox: [],
      lastFlush: performance.now(),
    };
    this.active.set(ev.pointerId, stroke);

    this.state.addOwnLive({ sid: stroke.sid, userId: this.state.selfId, style, pts: stroke.pts });
    this.hooks.sendNow({ t: 'begin', sid: stroke.sid, style, pts: [p.x, p.y] });
    this.hooks.dirty(dotBox(p.x, p.y, style.width));
    this.localCursor = p;
    this.hooks.overlayDirty();
    this.sendCursor(p.x, p.y, true, true);
  }

  private onPointerMove(ev: PointerEvent): void {
    const stroke = this.active.get(ev.pointerId);
    const samples = this.samplesFrom(ev);

    if (stroke === undefined) {
      // Not drawing: just a cursor update.
      const last = samples[samples.length - 1];
      if (last !== undefined) {
        this.localCursor = last;
        this.hooks.overlayDirty();
        this.sendCursor(last.x, last.y, false, false);
      }
      return;
    }

    ev.preventDefault();
    let dirty: BBox | null = null;
    for (const sample of samples) {
      // Include the two previous points: quadratic smoothing reshapes the join.
      const before = Math.max(0, stroke.pts.length - 4);
      const added = appendPoints(stroke.pts, [sample.x, sample.y]);
      if (added === 0) continue;
      stroke.outbox.push(sample.x, sample.y);
      const tail = stroke.pts.slice(before);
      const box = boundsOf(tail, stroke.style.width);
      dirty = dirty === null ? box : union(dirty, box);
    }
    const last = samples[samples.length - 1];
    if (last !== undefined) {
      this.localCursor = last;
      this.sendCursor(last.x, last.y, true, false);
    }
    if (dirty !== null) this.hooks.dirty(dirty);
    this.hooks.overlayDirty();
  }

  private onPointerUp(ev: PointerEvent, how: 'end' | 'cancel'): void {
    const stroke = this.active.get(ev.pointerId);
    if (stroke === undefined) return;
    // A pointerup carries a final position worth keeping.
    if (how === 'end') {
      const p = this.toWorld(ev.clientX, ev.clientY);
      if (appendPoints(stroke.pts, [p.x, p.y]) > 0) {
        stroke.outbox.push(p.x, p.y);
        this.hooks.dirty(dotBox(p.x, p.y, stroke.style.width));
      }
    }
    try {
      this.canvas.releasePointerCapture(ev.pointerId);
    } catch {
      /* already released */
    }
    this.finish(stroke, how);
    this.sendCursor(this.localCursor?.x ?? 0, this.localCursor?.y ?? 0, false, true);
  }

  private onPointerLeave(ev: PointerEvent): void {
    if (this.active.has(ev.pointerId)) return;
    this.localCursor = null;
    this.hooks.overlayDirty();
    this.sendCursor(-1000, -1000, false, true);
  }

  private finish(stroke: ActiveStroke, how: 'end' | 'cancel'): void {
    this.active.delete(stroke.pointerId);
    if (how === 'cancel') {
      const removed = this.state.removeOwnLive(stroke.sid);
      if (removed !== undefined) this.hooks.dirty(boundsOf(removed.pts, removed.style.width));
      this.hooks.sendNow({ t: 'cancel', sid: stroke.sid });
      return;
    }
    this.flush(stroke);
    // `n` lets the server detect a lossy stream: if its accumulated count
    // differs, the two sides simplified different input and it says so.
    this.hooks.sendNow({ t: 'end', sid: stroke.sid, n: stroke.pts.length >> 1 });
  }

  private flush(stroke: ActiveStroke): void {
    if (stroke.outbox.length === 0) return;
    const pts = stroke.outbox;
    stroke.outbox = [];
    stroke.lastFlush = performance.now();
    this.hooks.send({ t: 'points', sid: stroke.sid, pts });
  }

  private sendCursor(x: number, y: number, active: boolean, force: boolean): void {
    const now = performance.now();
    if (!force) {
      if (now - this.lastCursorSent < CURSOR_FLUSH_MS) return;
      const prev = this.lastCursorPos;
      if (prev !== null && Math.abs(prev.x - x) < CURSOR_MIN_DELTA && Math.abs(prev.y - y) < CURSOR_MIN_DELTA) {
        return;
      }
    }
    this.lastCursorSent = now;
    this.lastCursorPos = { x, y };
    this.hooks.send({ t: 'cursor', x, y, active });
  }

  /**
   * All the real samples behind one `pointermove`. Browsers coalesce input to
   * the frame rate; `getCoalescedEvents` gives back the ones that were merged.
   */
  private samplesFrom(ev: PointerEvent): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    const coalesced = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [];
    if (coalesced.length > 0) {
      for (const sample of coalesced) out.push(this.toWorld(sample.clientX, sample.clientY));
    } else {
      out.push(this.toWorld(ev.clientX, ev.clientY));
    }
    return out;
  }

  /** Viewport coordinates -> world coordinates, clamped to the paper. */
  private toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.rect;
    const w = rect.width === 0 ? 1 : rect.width;
    const h = rect.height === 0 ? 1 : rect.height;
    return {
      x: quantize(clamp(((clientX - rect.left) / w) * WORLD_W, 0, WORLD_W)),
      y: quantize(clamp(((clientY - rect.top) / h) * WORLD_H, 0, WORLD_H)),
    };
  }

  private nextStrokeId(): string {
    // `${userId}-` prefix is required by the server; the nonce keeps ids unique
    // across reloads that reuse the same identity.
    return `${this.state.selfId ?? 'me'}-${sessionNonce}${++this.strokeCounter}`;
  }
}

function boundsOf(pts: number[], width: number): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i]!;
    const y = pts[i + 1]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return [0, 0, 0, 0];
  const pad = width / 2 + 1;
  return [minX - pad, minY - pad, maxX + pad, maxY + pad];
}

function dotBox(x: number, y: number, width: number): BBox {
  const pad = width / 2 + 1;
  return [x - pad, y - pad, x + pad, y + pad];
}

function union(a: BBox, b: BBox): BBox {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
