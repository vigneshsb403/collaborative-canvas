import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  appendPoints,
  bboxIntersects,
  clamp,
  sanitizePoints,
  sanitizeStyle,
  simplify,
  sqSegmentDistance,
  strokeBBox,
  unionBBox,
} from '../shared/geometry.js';
import { LIMITS, quantize } from '../shared/protocol.js';

describe('simplify (RDP)', () => {
  it('keeps strokes with fewer than three points untouched', () => {
    assert.deepEqual(simplify([]), []);
    assert.deepEqual(simplify([1, 2]), [1, 2]);
    assert.deepEqual(simplify([1, 2, 3, 4]), [1, 2, 3, 4]);
  });

  it('collapses collinear points to the two endpoints', () => {
    const straight = [0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0];
    assert.deepEqual(simplify(straight), [0, 0, 5, 0]);
  });

  it('preserves corners that exceed the tolerance', () => {
    const zigzag = [0, 0, 5, 20, 10, 0];
    assert.deepEqual(simplify(zigzag), zigzag);
  });

  it('drops deviations below the tolerance', () => {
    // A 0.1-unit bump is well inside the 0.45 default tolerance.
    assert.deepEqual(simplify([0, 0, 5, 0.1, 10, 0]), [0, 0, 10, 0]);
  });

  it('always keeps the first and last point', () => {
    const noisy: number[] = [];
    for (let i = 0; i < 200; i++) noisy.push(i, Math.sin(i / 7) * 30);
    const out = simplify(noisy);
    assert.equal(out[0], noisy[0]);
    assert.equal(out[1], noisy[1]);
    assert.equal(out[out.length - 2], noisy[noisy.length - 2]);
    assert.equal(out[out.length - 1], noisy[noisy.length - 1]);
    assert.ok(out.length < noisy.length, 'expected some reduction');
    assert.equal(out.length % 2, 0);
  });

  it('is deterministic — the property the client/server canonicalisation relies on', () => {
    const pts: number[] = [];
    for (let i = 0; i < 500; i++) pts.push(quantize(i * 0.7), quantize(Math.cos(i / 11) * 40));
    assert.deepEqual(simplify(pts), simplify(pts.slice()));
  });

  it('handles a 4000-point stroke without recursing', () => {
    const pts: number[] = [];
    for (let i = 0; i < LIMITS.maxPointsPerStroke; i++) pts.push(i * 0.25, (i % 2) * 0.9);
    assert.doesNotThrow(() => simplify(pts));
  });

  it('reduces a realistic hand-drawn stroke by a useful margin', () => {
    // Smooth arc sampled at pointer-event density, plus a little jitter.
    const pts: number[] = [];
    for (let i = 0; i < 400; i++) {
      const t = i / 400;
      pts.push(
        quantize(200 + Math.cos(t * Math.PI) * 150 + Math.sin(i) * 0.2),
        quantize(300 + Math.sin(t * Math.PI) * 150 + Math.cos(i) * 0.2),
      );
    }
    const out = simplify(pts);
    assert.ok(out.length / pts.length < 0.5, `expected >50% reduction, got ${out.length}/${pts.length}`);
  });
});

describe('sqSegmentDistance', () => {
  it('measures perpendicular distance inside the segment', () => {
    assert.equal(sqSegmentDistance(5, 3, 0, 0, 10, 0), 9);
  });

  it('clamps to the endpoints outside the segment', () => {
    assert.equal(sqSegmentDistance(-4, 0, 0, 0, 10, 0), 16);
    assert.equal(sqSegmentDistance(14, 0, 0, 0, 10, 0), 16);
  });

  it('handles a degenerate segment', () => {
    assert.equal(sqSegmentDistance(3, 4, 1, 1, 1, 1), 4 + 9);
  });
});

describe('strokeBBox', () => {
  it('inflates by half the line width plus antialias slop', () => {
    assert.deepEqual(strokeBBox([10, 10, 20, 30], 4), [7, 7, 23, 33]);
  });

  it('gives a dot a real area', () => {
    const box = strokeBBox([50, 50], 10);
    assert.deepEqual(box, [44, 44, 56, 56]);
  });

  it('never under-estimates — every point is inside', () => {
    const pts = [5, 90, 200, 12, 33, 400];
    const [minX, minY, maxX, maxY] = strokeBBox(pts, 8);
    for (let i = 0; i < pts.length; i += 2) {
      assert.ok(pts[i]! >= minX && pts[i]! <= maxX);
      assert.ok(pts[i + 1]! >= minY && pts[i + 1]! <= maxY);
    }
  });
});

describe('bbox helpers', () => {
  it('detects overlap, including edge contact', () => {
    assert.equal(bboxIntersects([0, 0, 10, 10], [5, 5, 15, 15]), true);
    assert.equal(bboxIntersects([0, 0, 10, 10], [10, 10, 20, 20]), true);
    assert.equal(bboxIntersects([0, 0, 10, 10], [11, 0, 20, 10]), false);
    assert.equal(bboxIntersects([0, 0, 10, 10], [0, 11, 10, 20]), false);
  });

  it('unions to the outer envelope', () => {
    assert.deepEqual(unionBBox([0, 0, 5, 5], [-3, 2, 4, 9]), [-3, 0, 5, 9]);
  });
});

describe('sanitizeStyle', () => {
  it('accepts a well-formed brush', () => {
    assert.deepEqual(sanitizeStyle({ color: '#AABBCC', width: 3.14, tool: 'brush' }), {
      color: '#aabbcc',
      width: 3.1,
      tool: 'brush',
    });
  });

  it('clamps width into range', () => {
    assert.equal(sanitizeStyle({ color: '#000000', width: 9999, tool: 'brush' })?.width, LIMITS.maxStrokeWidth);
    assert.equal(sanitizeStyle({ color: '#000000', width: -5, tool: 'brush' })?.width, LIMITS.minStrokeWidth);
  });

  it('rejects junk', () => {
    assert.equal(sanitizeStyle(null), null);
    assert.equal(sanitizeStyle('#fff'), null);
    assert.equal(sanitizeStyle({ color: 'red', width: 2, tool: 'brush' }), null);
    assert.equal(sanitizeStyle({ color: '#12345', width: 2, tool: 'brush' }), null);
    assert.equal(sanitizeStyle({ color: '#000000', width: Number.NaN, tool: 'brush' }), null);
    assert.equal(sanitizeStyle({ color: '#000000', width: Infinity, tool: 'brush' }), null);
  });

  it('does not treat an unknown tool as an eraser', () => {
    assert.equal(sanitizeStyle({ color: '#000000', width: 2, tool: 'nuke' })?.tool, 'brush');
  });

  it('lets the eraser through without a colour', () => {
    assert.equal(sanitizeStyle({ width: 20, tool: 'eraser' })?.tool, 'eraser');
  });
});

describe('sanitizePoints', () => {
  it('quantises to the wire grid', () => {
    assert.deepEqual(sanitizePoints([1.234, 5.678]), [1.2, 5.7]);
  });

  it('rejects structurally broken input', () => {
    assert.equal(sanitizePoints('nope'), null);
    assert.equal(sanitizePoints([1, 2, 3]), null);
    assert.equal(sanitizePoints([1, '2']), null);
    assert.equal(sanitizePoints([Number.NaN, 0]), null);
    assert.equal(sanitizePoints([0, Infinity]), null);
    assert.equal(sanitizePoints(new Array(20).fill(0), 4), null);
  });

  it('clamps wild coordinates instead of rejecting them', () => {
    const out = sanitizePoints([-99999, 99999])!;
    assert.ok(out[0]! > -99999 && out[1]! < 99999);
  });
});

describe('appendPoints', () => {
  it('drops points inside the minimum distance', () => {
    const acc: number[] = [];
    assert.equal(appendPoints(acc, [0, 0]), 1);
    assert.equal(appendPoints(acc, [0.1, 0.1]), 0, 'too close, should be dropped');
    assert.equal(appendPoints(acc, [10, 10]), 1);
    assert.deepEqual(acc, [0, 0, 10, 10]);
  });

  it('thins a dense batch relative to the running tail', () => {
    const acc: number[] = [];
    appendPoints(acc, [0, 0, 0.2, 0, 0.4, 0, 0.6, 0, 5, 0]);
    assert.deepEqual(acc, [0, 0, 5, 0]);
  });
});

describe('clamp / quantize', () => {
  it('clamps', () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-1, 0, 10), 0);
    assert.equal(clamp(11, 0, 10), 10);
  });

  it('quantises half-up', () => {
    assert.equal(quantize(1.25), 1.3);
    assert.equal(quantize(-1.24), -1.2);
  });
});
