import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { OpLog } from '../shared/oplog.js';
import type { ClearOp, Op, StrokeOp } from '../shared/protocol.js';

function stroke(seq: number, userId = 'u1'): StrokeOp {
  return {
    kind: 'stroke',
    id: `${userId}-s${seq}`,
    seq,
    userId,
    ts: 1000 + seq,
    style: { color: '#000000', width: 2, tool: 'brush' },
    pts: [seq, seq, seq + 1, seq + 1],
    bbox: [seq - 2, seq - 2, seq + 3, seq + 3],
    undone: false,
  };
}

function clear(seq: number, userId = 'u1'): ClearOp {
  return { kind: 'clear', id: `${userId}-clr${seq}`, seq, userId, ts: 1000 + seq, undone: false };
}

const ids = (ops: Op[]): string[] => ops.map((o) => o.id);

describe('OpLog ordering', () => {
  it('appends in sequence order', () => {
    const log = new OpLog();
    log.append(stroke(1));
    log.append(stroke(2));
    log.append(stroke(3));
    assert.deepEqual(ids(log.ops), ['u1-s1', 'u1-s2', 'u1-s3']);
    assert.equal(log.seq, 3);
  });

  it('inserts an out-of-order arrival at its sequence position', () => {
    // The client can legitimately see a later `commit` before an earlier one
    // when messages are batched across a reconnect.
    const log = new OpLog();
    log.append(stroke(3));
    log.append(stroke(1));
    log.append(stroke(2));
    assert.deepEqual(ids(log.ops), ['u1-s1', 'u1-s2', 'u1-s3']);
    assert.equal(log.seq, 3, 'seq tracks the maximum, not the last arrival');
  });

  it('is idempotent — a replayed op is ignored', () => {
    const log = new OpLog();
    const op = stroke(1);
    log.append(op);
    log.append(op);
    log.append(stroke(1));
    assert.equal(log.size, 1);
  });

  it('delta-slices by seq', () => {
    const log = new OpLog();
    for (let i = 1; i <= 5; i++) log.append(stroke(i));
    assert.deepEqual(ids(log.opsSince(0)), ['u1-s1', 'u1-s2', 'u1-s3', 'u1-s4', 'u1-s5']);
    assert.deepEqual(ids(log.opsSince(3)), ['u1-s4', 'u1-s5']);
    assert.deepEqual(ids(log.opsSince(5)), []);
    assert.deepEqual(ids(log.opsSince(99)), []);
  });
});

describe('OpLog visibility', () => {
  it('hides undone strokes', () => {
    const log = new OpLog();
    log.append(stroke(1));
    log.append(stroke(2));
    assert.equal(log.setUndone('u1-s1', true), true);
    assert.deepEqual(ids(log.visibleStrokes()), ['u1-s2']);
  });

  it('reports no change when the flag already matches', () => {
    const log = new OpLog();
    log.append(stroke(1));
    assert.equal(log.setUndone('u1-s1', true), true);
    assert.equal(log.setUndone('u1-s1', true), false, 'second undo of the same op is a no-op');
    assert.equal(log.setUndone('missing', true), false);
  });

  it('bumps the history version only on real changes', () => {
    const log = new OpLog();
    log.append(stroke(1));
    const before = log.hv;
    log.setUndone('u1-s1', true);
    assert.equal(log.hv, before + 1);
    log.setUndone('u1-s1', true);
    assert.equal(log.hv, before + 1);
  });

  it('treats a clear as hiding everything before it', () => {
    const log = new OpLog();
    log.append(stroke(1));
    log.append(stroke(2));
    log.append(clear(3));
    log.append(stroke(4));
    assert.equal(log.activeClearSeq, 3);
    assert.deepEqual(ids(log.visibleStrokes()), ['u1-s4']);
  });

  it('restores the pre-clear picture when the clear is undone', () => {
    const log = new OpLog();
    log.append(stroke(1));
    log.append(stroke(2));
    log.append(clear(3));
    log.setUndone('u1-clr3', true);
    assert.equal(log.activeClearSeq, 0);
    assert.deepEqual(ids(log.visibleStrokes()), ['u1-s1', 'u1-s2']);
  });

  it('keeps an independently undone stroke hidden after undoing the clear', () => {
    const log = new OpLog();
    log.append(stroke(1));
    log.append(stroke(2));
    log.setUndone('u1-s1', true);
    log.append(clear(3));
    log.setUndone('u1-clr3', true);
    assert.deepEqual(ids(log.visibleStrokes()), ['u1-s2'], 's1 was undone on its own merit');
  });

  it('uses the newest active clear when there are several', () => {
    const log = new OpLog();
    log.append(stroke(1));
    log.append(clear(2));
    log.append(stroke(3));
    log.append(clear(4));
    log.append(stroke(5));
    assert.equal(log.activeClearSeq, 4);
    log.setUndone('u1-clr4', true);
    assert.equal(log.activeClearSeq, 2, 'falls back to the older clear');
    assert.deepEqual(ids(log.visibleStrokes()), ['u1-s3', 'u1-s5']);
    log.setUndone('u1-clr2', true);
    assert.equal(log.activeClearSeq, 0);
    assert.deepEqual(ids(log.visibleStrokes()), ['u1-s1', 'u1-s3', 'u1-s5']);
  });

  it('is order-independent: the same messages in any order give the same picture', () => {
    const build = (order: Op[]): string[] => {
      const log = new OpLog();
      for (const op of order) log.append(op);
      log.setUndone('u1-s2', true);
      return ids(log.visibleStrokes());
    };
    const ops = [stroke(1), stroke(2), clear(3), stroke(4), stroke(5)];
    const expected = build(ops);
    assert.deepEqual(build([ops[4]!, ops[0]!, ops[3]!, ops[2]!, ops[1]!]), expected);
    assert.deepEqual(build([ops[2]!, ops[1]!, ops[4]!, ops[0]!, ops[3]!]), expected);
  });

  it('never reports a clear op as visible', () => {
    const log = new OpLog();
    const c = clear(1);
    log.append(c);
    assert.equal(log.isVisible(c), false);
  });
});

describe('OpLog compaction', () => {
  it('drops ops behind a clear and reports what it removed', () => {
    const log = new OpLog();
    log.append(stroke(1));
    log.append(stroke(2));
    log.append(clear(3));
    log.append(stroke(4));
    const removed = log.compactBelow(3);
    assert.deepEqual(removed.sort(), ['u1-clr3', 'u1-s1', 'u1-s2']);
    assert.equal(log.size, 1);
    assert.equal(log.truncatedBelowSeq, 3);
    assert.equal(log.activeClearSeq, 0, 'the clear itself is gone, so nothing is masked');
    assert.deepEqual(ids(log.visibleStrokes()), ['u1-s4'], 'the visible picture is unchanged');
    assert.equal(log.get('u1-s1'), undefined);
  });

  it('is a no-op below the first seq', () => {
    const log = new OpLog();
    log.append(stroke(5));
    assert.deepEqual(log.compactBelow(1), []);
    assert.equal(log.size, 1);
  });

  it('counts stored points', () => {
    const log = new OpLog();
    log.append(stroke(1));
    log.append(stroke(2));
    log.append(clear(3));
    assert.equal(log.pointCount(), 4, 'two points per stroke, clears store none');
  });
});
