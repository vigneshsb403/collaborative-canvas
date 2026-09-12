/**
 * Pure geometry helpers shared by client and server.
 *
 * Everything here operates on flat `[x0, y0, x1, y1, ...]` arrays and is
 * deterministic (only +, -, *, / and comparisons on IEEE-754 doubles), which is
 * what lets the client and the server independently simplify the same raw
 * stroke and arrive at byte-identical results — see ARCHITECTURE.md
 * ("Canonicalisation").
 */

import type { BBox, StrokeStyle, Tool } from './protocol.js';
import { LIMITS, WORLD_H, WORLD_W, quantize } from './protocol.js';

/** Default simplification tolerance in world units (sub-pixel at 1x zoom). */
export const SIMPLIFY_TOLERANCE = 0.45;

/** Points closer together than this are dropped at capture time. */
export const MIN_POINT_DISTANCE = 0.75;

/**
 * Ramer–Douglas–Peucker polyline simplification, iterative (no recursion, so a
 * 4000-point stroke can't blow the stack) and allocation-light.
 *
 * Typical reduction on a mouse-drawn stroke is 60–80% of points with no visible
 * change once the path is rendered with quadratic smoothing.
 */
export function simplify(pts: number[], tolerance = SIMPLIFY_TOLERANCE): number[] {
  const n = pts.length >> 1;
  if (n < 3) return pts.slice();

  const tol2 = tolerance * tolerance;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  // Explicit stack of [firstIndex, lastIndex] segments.
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const last = stack.pop()!;
    const first = stack.pop()!;
    if (last - first < 2) continue;

    const ax = pts[first * 2]!;
    const ay = pts[first * 2 + 1]!;
    const bx = pts[last * 2]!;
    const by = pts[last * 2 + 1]!;

    let maxDist = -1;
    let maxIdx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = sqSegmentDistance(pts[i * 2]!, pts[i * 2 + 1]!, ax, ay, bx, by);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }

    if (maxDist > tol2 && maxIdx > 0) {
      keep[maxIdx] = 1;
      stack.push(first, maxIdx, maxIdx, last);
    }
  }

  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(pts[i * 2]!, pts[i * 2 + 1]!);
  }
  return out;
}

/** Squared distance from point (px,py) to segment (ax,ay)-(bx,by). */
export function sqSegmentDistance(
  px: number, py: number, ax: number, ay: number, bx: number, by: number,
): number {
  let x = ax;
  let y = ay;
  const dx = bx - ax;
  const dy = by - ay;
  if (dx !== 0 || dy !== 0) {
    const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = bx;
      y = by;
    } else if (t > 0) {
      x = ax + dx * t;
      y = ay + dy * t;
    }
  }
  const ex = px - x;
  const ey = py - y;
  return ex * ex + ey * ey;
}

/**
 * Axis-aligned bounds of a stroke, inflated by half the line width plus a
 * 1-unit slop for the round cap / antialiasing fringe. Used for dirty-rect
 * repaints, so it must never under-estimate.
 */
export function strokeBBox(pts: number[], width: number): BBox {
  if (pts.length === 0) return [0, 0, 0, 0];
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
  const pad = width / 2 + 1;
  return [minX - pad, minY - pad, maxX + pad, maxY + pad];
}

export function unionBBox(a: BBox, b: BBox): BBox {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

export function bboxArea(b: BBox): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

/* ------------------------------------------------------------------ */
/* Validation — every value that arrives from the network goes through  */
/* one of these before it reaches shared state.                         */
/* ------------------------------------------------------------------ */

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function sanitizeStyle(input: unknown): StrokeStyle | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as Record<string, unknown>;

  const tool: Tool = raw.tool === 'eraser' ? 'eraser' : 'brush';

  let color = '#000000';
  if (typeof raw.color === 'string' && HEX_COLOR.test(raw.color)) {
    color = raw.color.toLowerCase();
  } else if (tool !== 'eraser') {
    return null;
  }

  const width = typeof raw.width === 'number' && Number.isFinite(raw.width)
    ? clamp(Math.round(raw.width * 10) / 10, LIMITS.minStrokeWidth, LIMITS.maxStrokeWidth)
    : null;
  if (width === null) return null;

  return { color, width, tool };
}

/**
 * Validate and canonicalise an incoming point batch: finite numbers only, even
 * length, clamped to the world box, quantised to the wire grid.
 * Returns `null` for structurally invalid input (the connection is then told
 * off rather than silently corrupting the room).
 */
export function sanitizePoints(input: unknown, maxPoints = LIMITS.maxPointsPerStroke): number[] | null {
  if (!Array.isArray(input)) return null;
  if (input.length % 2 !== 0) return null;
  if (input.length > maxPoints * 2) return null;
  const out = new Array<number>(input.length);
  for (let i = 0; i < input.length; i += 2) {
    const x = input[i];
    const y = input[i + 1];
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out[i] = quantize(clamp(x, -WORLD_W, WORLD_W * 2));
    out[i + 1] = quantize(clamp(y, -WORLD_H, WORLD_H * 2));
  }
  return out;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Append `next` to `acc`, dropping points that are within MIN_POINT_DISTANCE of
 * the previous kept point. Applied identically on both ends of the wire so the
 * accumulated raw stroke stays in sync.
 */
export function appendPoints(acc: number[], next: number[], minDist = MIN_POINT_DISTANCE): number {
  const min2 = minDist * minDist;
  let added = 0;
  for (let i = 0; i < next.length; i += 2) {
    const x = next[i]!;
    const y = next[i + 1]!;
    if (acc.length >= 2) {
      const dx = x - acc[acc.length - 2]!;
      const dy = y - acc[acc.length - 1]!;
      if (dx * dx + dy * dy < min2) continue;
    }
    acc.push(x, y);
    added++;
  }
  return added;
}
