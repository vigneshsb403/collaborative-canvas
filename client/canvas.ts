/**
 * Canvas rendering.
 *
 * Three surfaces, each with a different update frequency:
 *
 *   committed  offscreen, device-resolution raster of every *committed* stroke.
 *              Written incrementally: a new stroke is drawn straight onto it, so
 *              the common case costs one path, not a replay of the whole log.
 *   content    on-screen. Per frame it blits the dirty rectangle of `committed`
 *              and then draws the strokes that are still in flight on top.
 *   overlay    on-screen, above everything: remote cursors and name tags. Kept
 *              separate so a moving cursor never forces a content repaint, and
 *              so a live eraser stroke cannot rub a cursor out.
 *
 * All drawing happens in *world* coordinates (1600x1000) via a single canvas
 * transform, so no call site does its own scaling arithmetic. The overlay is the
 * exception: it works in CSS pixels so label text keeps a constant size.
 *
 * The only full-log replay is `repaintAll`, needed on resize (the raster
 * resolution changed) and on clear/undo-of-clear. An ordinary undo repaints just
 * the bounding box of the affected stroke, redrawing only the strokes that
 * overlap it.
 */

import { bboxIntersects, unionBBox } from '../shared/geometry.js';
import type { BBox, LiveStroke, StrokeOp, StrokeStyle } from '../shared/protocol.js';
import { WORLD_H, WORLD_W } from '../shared/protocol.js';
import type { ClientState, Cursor } from './state.js';

const TAU = Math.PI * 2;
/** The whole world, used when something invalidates everything. */
const WORLD_BOX: BBox = [0, 0, WORLD_W, WORLD_H];

export interface RenderStats {
  fps: number;
  /** Strokes rasterised during the last presented frame. */
  strokesDrawn: number;
  /** Fraction of the surface repainted in the last frame, 0..1. */
  dirtyRatio: number;
  fullRepaints: number;
}

export class Renderer {
  private readonly content: CanvasRenderingContext2D;
  private readonly overlay: CanvasRenderingContext2D;
  private committedCanvas: HTMLCanvasElement;
  private committed: CanvasRenderingContext2D;

  /** World units -> CSS pixels. */
  private scale = 1;
  private dpr = 1;
  private cssWidth = WORLD_W;
  private cssHeight = WORLD_H;

  /** Accumulated dirty region for the next frame, in world units. */
  private dirty: BBox | null = null;
  private overlayDirty = true;
  /** Rectangles the overlay painted last frame, in CSS pixels. */
  private lastCursorRects: BBox[] = [];
  /** Local brush preview: where our own pointer is and how big the tip is. */
  private localBrush: { x: number; y: number; width: number; color: string; erasing: boolean } | null = null;

  private frames = 0;
  private lastFpsAt = 0;
  stats: RenderStats = { fps: 0, strokesDrawn: 0, dirtyRatio: 0, fullRepaints: 0 };

  constructor(
    private readonly contentCanvas: HTMLCanvasElement,
    private readonly overlayCanvas: HTMLCanvasElement,
  ) {
    this.content = must(contentCanvas.getContext('2d'));
    this.overlay = must(overlayCanvas.getContext('2d'));
    this.committedCanvas = document.createElement('canvas');
    this.committed = must(this.committedCanvas.getContext('2d'));
    this.lastFpsAt = performance.now();
  }

  /**
   * Match the backing stores to the element's CSS box and the device pixel
   * ratio. Returns true when the raster was resized, which invalidates the
   * committed layer and requires a full repaint.
   */
  resize(cssWidth: number, cssHeight: number, dpr: number): boolean {
    const nextW = Math.max(1, Math.round(cssWidth * dpr));
    const nextH = Math.max(1, Math.round(cssHeight * dpr));
    if (this.contentCanvas.width === nextW && this.contentCanvas.height === nextH && this.dpr === dpr) {
      return false;
    }

    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.dpr = dpr;
    // World -> device pixels. The element's CSS box is aspect-fitted to the
    // world by the layout, so one factor covers both axes.
    this.scale = nextW / WORLD_W;

    for (const canvas of [this.contentCanvas, this.overlayCanvas, this.committedCanvas]) {
      canvas.width = nextW;
      canvas.height = nextH;
    }

    const k = this.scale;
    this.content.setTransform(k, 0, 0, k, 0, 0);
    this.committed.setTransform(k, 0, 0, k, 0, 0);
    // The overlay works in CSS pixels so text stays a constant size.
    this.overlay.setTransform(dpr, 0, 0, dpr, 0, 0);

    for (const ctx of [this.content, this.committed]) {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
    }
    this.markDirty(null);
    this.overlayDirty = true;
    return true;
  }

  /**
   * Grow a region by a couple of *device* pixels.
   *
   * Op bounds are computed in world units (they travel on the wire), so their
   * padding is resolution-independent — which means that when the paper is
   * displayed small, one world unit is less than one device pixel and the
   * antialiased fringe of a stroke can fall outside its own bounds. Clearing
   * exactly the bounds then leaves a ghost pixel behind after an undo. Every
   * clear, clip and blit therefore uses this inflated box.
   */
  private inflate(box: BBox, devicePixels = 2): BBox {
    const m = devicePixels / Math.max(0.0001, this.scale);
    return [box[0] - m, box[1] - m, box[2] + m, box[3] + m];
  }

  /** Queue a region for the next presented frame. `null` means everything. */
  markDirty(bbox: BBox | null): void {
    if (bbox === null) {
      this.dirty = WORLD_BOX;
      return;
    }
    this.dirty = this.dirty === null ? bbox : unionBBox(this.dirty, bbox);
  }

  markOverlayDirty(): void {
    this.overlayDirty = true;
  }

  /**
   * Show the true brush footprint under the local pointer. Worth the few lines:
   * without it there is no way to judge stroke width before committing to a
   * stroke, and the native cursor gives no size feedback at all.
   */
  setLocalBrush(brush: { x: number; y: number; width: number; color: string; erasing: boolean } | null): void {
    this.localBrush = brush;
    this.overlayDirty = true;
  }

  get hasWork(): boolean {
    return this.dirty !== null || this.overlayDirty;
  }

  /* ---------------------------------------------------------------- */
  /* Committed layer                                                   */
  /* ---------------------------------------------------------------- */

  /** Rasterise one freshly committed op. O(1) in the size of the log. */
  commitOp(op: StrokeOp): void {
    if (op.undone) return;
    this.drawStroke(this.committed, op.pts, op.style);
  }

  /**
   * Re-rasterise a region: clear it, then redraw every visible stroke whose
   * bounds overlap it, clipped. Cost is proportional to the strokes *in that
   * region*, which is what makes undo cheap on a busy canvas.
   */
  repaintRegion(state: ClientState, bbox: BBox): void {
    const box = clampBox(this.inflate(bbox));
    const ctx = this.committed;
    ctx.save();
    ctx.beginPath();
    ctx.rect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
    ctx.clip();
    ctx.clearRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
    let drawn = 0;
    for (const op of state.log.ops) {
      if (op.kind !== 'stroke') continue;
      if (op.undone || op.seq <= state.log.activeClearSeq) continue;
      if (!bboxIntersects(op.bbox, box)) continue;
      this.drawStroke(ctx, op.pts, op.style);
      drawn++;
    }
    ctx.restore();
    this.stats.strokesDrawn = drawn;
    this.markDirty(box);
  }

  /** Replay the whole visible log. Only for resize, clear and undo-of-clear. */
  repaintAll(state: ClientState): void {
    const ctx = this.committed;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.committedCanvas.width, this.committedCanvas.height);
    ctx.restore();
    let drawn = 0;
    for (const op of state.log.ops) {
      if (op.kind !== 'stroke') continue;
      if (op.undone || op.seq <= state.log.activeClearSeq) continue;
      this.drawStroke(ctx, op.pts, op.style);
      drawn++;
    }
    this.stats.strokesDrawn = drawn;
    this.stats.fullRepaints++;
    this.markDirty(null);
  }

  /* ---------------------------------------------------------------- */
  /* Frame presentation                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Compose one frame: blit the dirty part of the committed raster, then draw
   * the in-flight strokes over it. Returns false when there was nothing to do.
   */
  present(state: ClientState): boolean {
    const now = performance.now();
    this.frames++;
    if (now - this.lastFpsAt >= 500) {
      this.stats.fps = Math.round((this.frames * 1000) / (now - this.lastFpsAt));
      this.frames = 0;
      this.lastFpsAt = now;
    }

    let painted = false;

    if (this.dirty !== null) {
      const box = clampBox(this.inflate(this.dirty));
      this.dirty = null;
      const ctx = this.content;

      // Blit in device pixels, snapped outwards to whole pixels so a fractional
      // world rect cannot leave a seam.
      const dx = Math.max(0, Math.floor(box[0] * this.scale));
      const dy = Math.max(0, Math.floor(box[1] * this.scale));
      const dw = Math.min(this.contentCanvas.width - dx, Math.ceil((box[2] - box[0]) * this.scale) + 1);
      const dh = Math.min(this.contentCanvas.height - dy, Math.ceil((box[3] - box[1]) * this.scale) + 1);

      if (dw > 0 && dh > 0) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(dx, dy, dw, dh);
        ctx.drawImage(this.committedCanvas, dx, dy, dw, dh, dx, dy, dw, dh);
        ctx.restore();

        if (state.live.size > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
          ctx.clip();
          for (const stroke of state.live.values()) {
            this.drawStroke(ctx, stroke.pts, stroke.style);
          }
          ctx.restore();
        }

        const total = this.contentCanvas.width * this.contentCanvas.height;
        this.stats.dirtyRatio = total === 0 ? 0 : (dw * dh) / total;
        painted = true;
      }
    }

    if (this.overlayDirty) {
      this.overlayDirty = false;
      this.drawCursors(state);
      painted = true;
    }

    return painted;
  }

  /** Every live stroke needs its area marked dirty (used after a resize). */
  markLiveDirty(live: Iterable<LiveStroke>): void {
    for (const stroke of live) {
      this.markDirty(strokeBoundsOf(stroke));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Cursors                                                           */
  /* ---------------------------------------------------------------- */

  private drawCursors(state: ClientState): void {
    const ctx = this.overlay;
    // Clear only what was painted last frame.
    for (const rect of this.lastCursorRects) {
      ctx.clearRect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
    }
    this.lastCursorRects = [];

    const k = this.cssWidth / WORLD_W;
    const now = performance.now();
    ctx.font = '600 11px ui-sans-serif, system-ui, -apple-system, sans-serif';
    ctx.textBaseline = 'middle';

    if (this.localBrush !== null) {
      this.lastCursorRects.push(this.paintLocalBrush(ctx, this.localBrush, k));
    }

    for (const [userId, cursor] of state.cursors) {
      if (userId === state.selfId) continue;
      const age = now - cursor.at;
      if (age > CURSOR_TTL_MS) continue;
      const alpha = age > CURSOR_FADE_MS ? 1 - (age - CURSOR_FADE_MS) / (CURSOR_TTL_MS - CURSOR_FADE_MS) : 1;

      const x = cursor.x * k;
      const y = cursor.y * k;
      const name = state.userName(userId);
      const color = state.userColor(userId);
      const rect = this.paintCursor(ctx, x, y, name, color, alpha, cursor);
      this.lastCursorRects.push(rect);
    }
  }

  private paintLocalBrush(
    ctx: CanvasRenderingContext2D,
    brush: { x: number; y: number; width: number; color: string; erasing: boolean },
    k: number,
  ): BBox {
    const x = brush.x * k;
    const y = brush.y * k;
    const r = Math.max(2.5, (brush.width / 2) * k);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.strokeStyle = brush.erasing ? 'rgba(20,22,30,0.55)' : 'rgba(20,22,30,0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash(brush.erasing ? [4, 3] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    // A contrasting inner ring keeps the outline visible over dark strokes.
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1.5, r - 1), 0, TAU);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.stroke();
    ctx.restore();
    const pad = 3;
    return [x - r - pad, y - r - pad, x + r + pad, y + r + pad];
  }

  private paintCursor(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    name: string,
    color: string,
    alpha: number,
    cursor: Cursor,
  ): BBox {
    const radius = cursor.active ? 7 : 5;
    const labelW = ctx.measureText(name).width + 12;
    const labelH = 17;

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

    // Ring, with a white halo so it stays visible over dark strokes.
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.75;
    ctx.stroke();
    if (cursor.active) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, TAU);
      ctx.fill();
    }

    // Name tag, flipped to stay inside the canvas near the edges.
    const flipX = x + labelW + radius + 6 > this.cssWidth;
    const lx = flipX ? x - radius - 6 - labelW : x + radius + 6;
    const ly = Math.min(this.cssHeight - labelH / 2 - 1, Math.max(labelH / 2 + 1, y));

    ctx.beginPath();
    roundRect(ctx, lx, ly - labelH / 2, labelW, labelH, 5);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = readableOn(color);
    ctx.fillText(name, lx + 6, ly + 0.5);
    ctx.restore();

    const pad = 4;
    return [
      Math.min(x - radius, lx) - pad,
      Math.min(y - radius, ly - labelH / 2) - pad,
      Math.max(x + radius, lx + labelW) + pad,
      Math.max(y + radius, ly + labelH / 2) + pad,
    ];
  }

  /* ---------------------------------------------------------------- */
  /* Stroke rasterisation                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Trace a point list as one path and stroke it once.
   *
   * Smoothing uses quadratic curves through segment midpoints with the raw
   * samples as control points: it removes the polyline faceting that a plain
   * `lineTo` chain shows at high zoom, costs one curve per point, and — unlike a
   * spline fit — needs no lookahead, so a stroke renders identically whether it
   * arrives all at once or a few points at a time.
   */
  private drawStroke(ctx: CanvasRenderingContext2D, pts: number[], style: StrokeStyle): void {
    const n = pts.length >> 1;
    if (n === 0) return;

    const erasing = style.tool === 'eraser';
    ctx.save();
    ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';

    if (n === 1) {
      // A tap: a filled dot of the same diameter as the stroke.
      ctx.beginPath();
      ctx.arc(pts[0]!, pts[1]!, Math.max(0.35, style.width / 2), 0, TAU);
      ctx.fillStyle = erasing ? '#000000' : style.color;
      ctx.fill();
      ctx.restore();
      return;
    }

    ctx.strokeStyle = erasing ? '#000000' : style.color;
    ctx.lineWidth = style.width;
    ctx.beginPath();
    ctx.moveTo(pts[0]!, pts[1]!);

    if (n === 2) {
      ctx.lineTo(pts[2]!, pts[3]!);
    } else {
      for (let i = 1; i < n - 1; i++) {
        const cx = pts[i * 2]!;
        const cy = pts[i * 2 + 1]!;
        const mx = (cx + pts[(i + 1) * 2]!) / 2;
        const my = (cy + pts[(i + 1) * 2 + 1]!) / 2;
        ctx.quadraticCurveTo(cx, cy, mx, my);
      }
      // Finish on the true last sample rather than a midpoint.
      const lx = pts[(n - 1) * 2]!;
      const ly = pts[(n - 1) * 2 + 1]!;
      ctx.quadraticCurveTo(lx, ly, lx, ly);
    }

    ctx.stroke();
    ctx.restore();
  }

}

const CURSOR_FADE_MS = 2500;
const CURSOR_TTL_MS = 4000;

function strokeBoundsOf(stroke: LiveStroke): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < stroke.pts.length; i += 2) {
    const x = stroke.pts[i]!;
    const y = stroke.pts[i + 1]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return [0, 0, 0, 0];
  const pad = stroke.style.width / 2 + 1;
  return [minX - pad, minY - pad, maxX + pad, maxY + pad];
}

function clampBox(b: BBox): BBox {
  return [
    Math.max(0, Math.min(WORLD_W, b[0])),
    Math.max(0, Math.min(WORLD_H, b[1])),
    Math.max(0, Math.min(WORLD_W, b[2])),
    Math.max(0, Math.min(WORLD_H, b[3])),
  ];
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Pick black or white text for a background colour, by perceived luminance. */
export function readableOn(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.6 ? '#10131a' : '#ffffff';
}

function must<T>(value: T | null): T {
  if (value === null) throw new Error('2D canvas context unavailable');
  return value;
}
