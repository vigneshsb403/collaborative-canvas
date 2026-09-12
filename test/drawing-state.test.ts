import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_STATE_LIMITS, DrawingState, type Result } from '../server/drawing-state.js';
import type { StrokeOp } from '../shared/protocol.js';

const STYLE = { color: '#ff0000', width: 4, tool: 'brush' as const };

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`);
  return r.value;
}

function expectFail<T>(r: Result<T>, code?: string): void {
  assert.equal(r.ok, false, 'expected a failure');
  if (!r.ok && code !== undefined) assert.equal(r.code, code);
}

let n = 0;
/** Draw a whole stroke in one go and return the committed op. */
function draw(state: DrawingState, userId: string, pts: number[] = [0, 0, 10, 10, 20, 30]): StrokeOp {
  const sid = `${userId}-s${++n}`;
  unwrap(state.beginStroke(userId, sid, STYLE, pts.slice(0, 2)));
  if (pts.length > 2) unwrap(state.addPoints(userId, sid, pts.slice(2)));
  return unwrap(state.endStroke(userId, sid)).op;
}

const visible = (state: DrawingState): string[] => state.log.visibleStrokes().map((o) => o.id);

describe('streaming strokes', () => {
  it('assigns a monotonically increasing seq', () => {
    const s = new DrawingState();
    assert.equal(draw(s, 'alice').seq, 1);
    assert.equal(draw(s, 'bob').seq, 2);
    assert.equal(draw(s, 'alice').seq, 3);
  });

  it('simplifies the accumulated path on commit', () => {
    const s = new DrawingState();
    const collinear = [0, 0, 5, 0, 10, 0, 15, 0, 20, 0];
    const op = draw(s, 'alice', collinear);
    assert.deepEqual(op.pts, [0, 0, 20, 0], 'collinear interior points are dropped');
    assert.deepEqual(op.bbox, [-3, -3, 23, 3]);
  });

  it('echoes back only the points it actually kept', () => {
    const s = new DrawingState();
    unwrap(s.beginStroke('alice', 'alice-a', STYLE, [0, 0]));
    // Second point is inside the dedupe radius, third is not.
    const kept = unwrap(s.addPoints('alice', 'alice-a', [0.2, 0.1, 8, 8]));
    assert.deepEqual(kept, [8, 8]);
  });

  it('rejects a stroke id that is not namespaced to the sender', () => {
    const s = new DrawingState();
    expectFail(s.beginStroke('alice', 'bob-1', STYLE, [0, 0]), 'bad_sid');
    expectFail(s.beginStroke('alice', 'nope', STYLE, [0, 0]), 'bad_sid');
    expectFail(s.beginStroke('alice', '', STYLE, [0, 0]), 'bad_sid');
    expectFail(s.beginStroke('alice', 'alice-<script>', STYLE, [0, 0]), 'bad_sid');
  });

  it('rejects a duplicate stroke id, live or committed', () => {
    const s = new DrawingState();
    unwrap(s.beginStroke('alice', 'alice-dup', STYLE, [0, 0]));
    expectFail(s.beginStroke('alice', 'alice-dup', STYLE, [0, 0]), 'dup_sid');
    unwrap(s.endStroke('alice', 'alice-dup'));
    expectFail(s.beginStroke('alice', 'alice-dup', STYLE, [0, 0]), 'dup_sid');
  });

  it('refuses to let one user touch another user\'s live stroke', () => {
    const s = new DrawingState();
    unwrap(s.beginStroke('alice', 'alice-x', STYLE, [0, 0]));
    expectFail(s.addPoints('bob', 'alice-x', [5, 5]), 'forbidden');
    expectFail(s.endStroke('bob', 'alice-x'), 'forbidden');
    expectFail(s.cancelStroke('bob', 'alice-x'), 'forbidden');
  });

  it('validates style and points at the door', () => {
    const s = new DrawingState();
    expectFail(s.beginStroke('alice', 'alice-1', { color: 'red', width: 1, tool: 'brush' }, [0, 0]), 'bad_style');
    expectFail(s.beginStroke('alice', 'alice-2', STYLE, [0, 'x']), 'bad_points');
    expectFail(s.beginStroke('alice', 'alice-3', STYLE, [0, 0, 1]), 'bad_points');
  });

  it('caps concurrent strokes per user (multi-touch abuse guard)', () => {
    const s = new DrawingState();
    for (let i = 0; i < DEFAULT_STATE_LIMITS.maxLiveStrokesPerUser; i++) {
      unwrap(s.beginStroke('alice', `alice-c${i}`, STYLE, [i, i]));
    }
    expectFail(s.beginStroke('alice', 'alice-over', STYLE, [0, 0]), 'too_many_live');
    // A different user is unaffected.
    unwrap(s.beginStroke('bob', 'bob-1', STYLE, [0, 0]));
  });

  it('truncates a stroke at the per-stroke point cap', () => {
    const s = new DrawingState();
    const many: number[] = [];
    for (let i = 0; i < DEFAULT_STATE_LIMITS.maxPointsPerStroke + 500; i++) many.push(i * 2, 0);
    unwrap(s.beginStroke('alice', 'alice-long', STYLE, many.slice(0, 2)));
    unwrap(s.addPoints('alice', 'alice-long', many.slice(2, 4000)));
    unwrap(s.addPoints('alice', 'alice-long', many.slice(4000)));
    const op = unwrap(s.endStroke('alice', 'alice-long')).op;
    assert.ok(op.pts.length / 2 <= DEFAULT_STATE_LIMITS.maxPointsPerStroke);
  });

  it('flags a point-count mismatch as a desync without dropping the stroke', () => {
    const s = new DrawingState();
    unwrap(s.beginStroke('alice', 'alice-d', STYLE, [0, 0, 10, 10]));
    const res = unwrap(s.endStroke('alice', 'alice-d', 99));
    assert.equal(res.desync, true);
    assert.equal(res.op.pts.length, 4);
  });

  it('reports an empty stroke rather than committing nothing', () => {
    const s = new DrawingState();
    unwrap(s.beginStroke('alice', 'alice-e', STYLE, []));
    expectFail(s.endStroke('alice', 'alice-e'), 'empty_stroke');
    // The pending entry is gone either way.
    expectFail(s.endStroke('alice', 'alice-e'), 'no_stroke');
  });

  it('commits a single-point tap as a dot', () => {
    const s = new DrawingState();
    const op = draw(s, 'alice', [42, 42]);
    assert.deepEqual(op.pts, [42, 42]);
  });

  it('exposes live strokes, optionally excluding one user', () => {
    const s = new DrawingState();
    unwrap(s.beginStroke('alice', 'alice-l', STYLE, [1, 1]));
    unwrap(s.beginStroke('bob', 'bob-l', STYLE, [2, 2]));
    assert.equal(s.liveStrokes().length, 2);
    assert.deepEqual(s.liveStrokes('alice').map((l) => l.sid), ['bob-l']);
    assert.equal(s.getPending('bob-l')?.userId, 'bob');
    assert.equal(s.getPending('nope'), undefined);
  });

  it('drops every live stroke for a user who disconnects', () => {
    const s = new DrawingState();
    unwrap(s.beginStroke('alice', 'alice-p1', STYLE, [1, 1]));
    unwrap(s.beginStroke('alice', 'alice-p2', STYLE, [2, 2]));
    unwrap(s.beginStroke('bob', 'bob-p', STYLE, [3, 3]));
    assert.deepEqual(s.dropUser('alice').sort(), ['alice-p1', 'alice-p2']);
    assert.deepEqual(s.dropUser('alice'), []);
    assert.equal(s.liveStrokes().length, 1);
  });
});

describe('clear', () => {
  it('hides everything and is itself an op', () => {
    const s = new DrawingState();
    draw(s, 'alice');
    draw(s, 'bob');
    const clearOp = unwrap(s.clear('bob'));
    assert.equal(clearOp.seq, 3);
    assert.deepEqual(visible(s), []);
  });

  it('refuses when there is nothing visible to clear', () => {
    const s = new DrawingState();
    expectFail(s.clear('alice'), 'already_clear');
    draw(s, 'alice');
    unwrap(s.clear('alice'));
    expectFail(s.clear('alice'), 'already_clear');
  });
});

describe('undo / redo — global scope', () => {
  it('walks back through the room-wide history regardless of author', () => {
    const s = new DrawingState();
    const a = draw(s, 'alice');
    draw(s, 'bob');
    unwrap(s.undo('carol', 'global'));
    assert.deepEqual(visible(s), [a.id], "carol undid bob's stroke");
    unwrap(s.undo('carol', 'global'));
    assert.deepEqual(visible(s), []);
    expectFail(s.undo('carol', 'global'), 'nothing_to_undo');
  });

  it('redoes in reverse order', () => {
    const s = new DrawingState();
    const a = draw(s, 'alice');
    const b = draw(s, 'bob');
    unwrap(s.undo('alice', 'global'));
    unwrap(s.undo('alice', 'global'));
    unwrap(s.redo('bob', 'global'));
    assert.deepEqual(visible(s), [a.id]);
    unwrap(s.redo('bob', 'global'));
    assert.deepEqual(visible(s), [a.id, b.id]);
    expectFail(s.redo('bob', 'global'), 'nothing_to_redo');
  });

  it('a new stroke truncates the global redo branch', () => {
    const s = new DrawingState();
    draw(s, 'alice');
    unwrap(s.undo('alice', 'global'));
    const fresh = draw(s, 'bob');
    expectFail(s.redo('alice', 'global'), 'nothing_to_redo');
    assert.deepEqual(visible(s), [fresh.id]);
  });

  it('undoes a clear, bringing the picture back', () => {
    const s = new DrawingState();
    const a = draw(s, 'alice');
    const b = draw(s, 'bob');
    unwrap(s.clear('carol'));
    assert.deepEqual(visible(s), []);
    unwrap(s.undo('dave', 'global'));
    assert.deepEqual(visible(s), [a.id, b.id], 'undoing the clear restores both strokes');
  });

  it('skips strokes that are already masked by a clear', () => {
    const s = new DrawingState();
    draw(s, 'alice');
    draw(s, 'alice');
    unwrap(s.clear('alice'));
    const c = draw(s, 'bob');
    // Top of history: the new stroke, then the clear. The two masked strokes
    // must not be "undone" into a no-op.
    unwrap(s.undo('alice', 'global'));
    assert.deepEqual(visible(s), [], 'undid the new stroke');
    unwrap(s.undo('alice', 'global'));
    assert.equal(s.log.activeClearSeq, 0, 'undid the clear');
    assert.equal(visible(s).length, 2);
    assert.ok(!visible(s).includes(c.id));
  });

  it('will not redo a stroke that would stay hidden behind a clear', () => {
    const s = new DrawingState();
    const a = draw(s, 'alice');
    unwrap(s.undo('alice', 'global'));
    assert.deepEqual(visible(s), []);
    draw(s, 'bob');
    unwrap(s.clear('bob'));
    // alice's personal redo still references `a`, but restoring it would be
    // invisible behind the clear, so it is skipped.
    expectFail(s.redo('alice', 'mine'), 'nothing_to_redo');
    assert.equal(s.log.get(a.id)?.undone, true);
  });
});

describe('undo / redo — per-user scope', () => {
  it('only touches the caller\'s own ops', () => {
    const s = new DrawingState();
    const a1 = draw(s, 'alice');
    const b1 = draw(s, 'bob');
    const a2 = draw(s, 'alice');
    unwrap(s.undo('alice', 'mine'));
    assert.deepEqual(visible(s), [a1.id, b1.id], 'alice undid her own latest, not bob\'s');
    unwrap(s.undo('alice', 'mine'));
    assert.deepEqual(visible(s), [b1.id]);
    expectFail(s.undo('alice', 'mine'), 'nothing_to_undo');
    // Bob still has his own.
    unwrap(s.undo('bob', 'mine'));
    assert.deepEqual(visible(s), []);
    assert.ok(a2.id !== a1.id);
  });

  it('lets a user redo work that somebody else undid globally', () => {
    const s = new DrawingState();
    const a = draw(s, 'alice');
    unwrap(s.undo('bob', 'global'));
    assert.deepEqual(visible(s), []);
    unwrap(s.redo('alice', 'mine'));
    assert.deepEqual(visible(s), [a.id], 'alice reinstated her stroke');
  });

  it('keeps a bystander\'s personal redo intact when someone else draws', () => {
    const s = new DrawingState();
    const a = draw(s, 'alice');
    unwrap(s.undo('alice', 'mine'));
    draw(s, 'bob'); // truncates the global redo branch, not alice's
    unwrap(s.redo('alice', 'mine'));
    assert.ok(visible(s).includes(a.id));
  });

  it('drops the author\'s own redo branch when they draw again', () => {
    const s = new DrawingState();
    draw(s, 'alice');
    unwrap(s.undo('alice', 'mine'));
    draw(s, 'alice');
    expectFail(s.redo('alice', 'mine'), 'nothing_to_redo');
  });
});

describe('concurrent undo (the conflict case)', () => {
  it('two users undoing at the same instant each consume a different op', () => {
    const s = new DrawingState();
    const a = draw(s, 'alice');
    const b = draw(s, 'bob');
    // Both requests arrive back-to-back; the server serialises them.
    const hvBefore = s.log.hv;
    const first = unwrap(s.undo('alice', 'global'));
    const second = unwrap(s.undo('bob', 'global'));
    assert.deepEqual(first.changes, [{ id: b.id, undone: true }]);
    assert.deepEqual(second.changes, [{ id: a.id, undone: true }], 'the stale entry was skipped, not double-undone');
    assert.deepEqual(visible(s), []);
    assert.equal(s.log.hv - hvBefore, 2, 'exactly two visibility changes happened, no double-undo');
  });

  it('a global undo of my op does not let me undo it twice', () => {
    const s = new DrawingState();
    const a = draw(s, 'alice');
    unwrap(s.undo('bob', 'global'));
    expectFail(s.undo('alice', 'mine'), 'nothing_to_undo');
    assert.equal(s.log.get(a.id)?.undone, true);
  });

  it('a double redo cannot resurrect an op twice', () => {
    const s = new DrawingState();
    draw(s, 'alice');
    unwrap(s.undo('alice', 'global'));
    unwrap(s.redo('alice', 'global'));
    expectFail(s.redo('bob', 'global'), 'nothing_to_redo');
    expectFail(s.redo('alice', 'mine'), 'nothing_to_redo');
  });

  it('survives a long interleaved undo/redo storm without corrupting state', () => {
    const s = new DrawingState();
    const users = ['alice', 'bob', 'carol'];
    for (let i = 0; i < 40; i++) draw(s, users[i % users.length]!);

    let rng = 12345;
    const next = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    for (let i = 0; i < 500; i++) {
      const user = users[Math.floor(next() * users.length)]!;
      const scope = next() < 0.5 ? 'global' : 'mine';
      const action = next() < 0.5 ? 'undo' : 'redo';
      if (action === 'undo') s.undo(user, scope);
      else s.redo(user, scope);

      // Invariant: visibility is always derivable, and visible strokes are
      // exactly the non-undone ones above the active clear.
      for (const op of s.log.ops) {
        if (op.kind !== 'stroke') continue;
        const shouldShow = !op.undone && op.seq > s.log.activeClearSeq;
        assert.equal(s.log.isVisible(op), shouldShow);
      }
    }
    assert.equal(s.log.size, 40, 'no op was ever added or lost');
  });
});

describe('canUndo / canRedo', () => {
  it('predicts the outcome of undo without mutating', () => {
    const s = new DrawingState();
    assert.equal(s.canUndo('alice', 'global'), false);
    assert.equal(s.canUndo('alice', 'mine'), false);
    draw(s, 'alice');
    assert.equal(s.canUndo('bob', 'global'), true);
    assert.equal(s.canUndo('bob', 'mine'), false, 'bob has drawn nothing');
    assert.equal(s.canUndo('alice', 'mine'), true);
    assert.equal(s.log.hv, 1, 'the predicates did not change history');
  });

  it('predicts the outcome of redo', () => {
    const s = new DrawingState();
    draw(s, 'alice');
    assert.equal(s.canRedo('alice', 'global'), false);
    unwrap(s.undo('alice', 'global'));
    assert.equal(s.canRedo('alice', 'global'), true);
    assert.equal(s.canRedo('bob', 'mine'), false);
    unwrap(s.redo('alice', 'global'));
    assert.equal(s.canRedo('alice', 'global'), false);
  });
});

describe('resource limits', () => {
  it('refuses new strokes once the op budget is spent, and says why', () => {
    const s = new DrawingState({ ...DEFAULT_STATE_LIMITS, maxOpsPerRoom: 4 });
    for (let i = 0; i < 4; i++) draw(s, 'alice', [i, i, i + 1, i + 1]);
    const res = s.beginStroke('alice', 'alice-over', STYLE, [0, 0]);
    expectFail(res, 'room_full');
    if (!res.ok) assert.match(res.message, /Clear the canvas/);
  });

  it('refuses new strokes once the point budget is spent', () => {
    const s = new DrawingState({ ...DEFAULT_STATE_LIMITS, maxPointsPerRoom: 10 });
    // A zigzag, so simplification cannot collapse it away.
    const pts: number[] = [];
    for (let i = 0; i < 14; i++) pts.push(i * 9, (i % 2) * 40);
    const op = draw(s, 'alice', pts);
    assert.ok(op.pts.length / 2 >= 10, `expected a fat stroke, got ${op.pts.length / 2} points`);
    expectFail(s.beginStroke('alice', 'alice-over', STYLE, [0, 0]), 'room_full');
  });

  it('compacts ops that sit behind a clear, preserving the visible picture', () => {
    const s = new DrawingState({ ...DEFAULT_STATE_LIMITS, maxOpsPerRoom: 10 });
    for (let i = 0; i < 6; i++) draw(s, 'alice', [i, i, i + 1, i + 1]);
    unwrap(s.clear('alice'));
    // Keep drawing until compaction triggers (>90% of 10 ops).
    const after: string[] = [];
    for (let i = 0; i < 3; i++) after.push(draw(s, 'bob', [i * 3, 0, i * 3 + 1, 1]).id);
    assert.ok(s.log.size < 10, `expected compaction, log has ${s.log.size}`);
    assert.deepEqual(visible(s), after, 'exactly the post-clear strokes remain visible');
    // Undo history no longer reaches past the compaction point.
    for (let i = 0; i < 10; i++) s.undo('alice', 'global');
    assert.deepEqual(visible(s), []);
  });

  it('never compacts when nothing is masked by a clear', () => {
    const s = new DrawingState({ ...DEFAULT_STATE_LIMITS, maxOpsPerRoom: 10 });
    for (let i = 0; i < 9; i++) draw(s, 'alice', [i, i, i + 1, i + 1]);
    assert.equal(s.log.size, 9, 'no visible op may ever be dropped');
  });

  it('bounds undo stack growth under repeated undo/redo', () => {
    const s = new DrawingState({ ...DEFAULT_STATE_LIMITS, maxUndoStack: 8 });
    draw(s, 'alice');
    for (let i = 0; i < 50; i++) {
      s.undo('alice', 'global');
      s.redo('alice', 'global');
    }
    // Still consistent afterwards.
    assert.equal(s.log.size, 1);
    assert.equal(s.canUndo('alice', 'global'), true);
  });
});
