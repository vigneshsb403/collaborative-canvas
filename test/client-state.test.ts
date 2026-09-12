/**
 * Unit tests for the browser's state mirror.
 *
 * `client/state.ts` is written without any DOM dependency precisely so this —
 * the trickiest client logic (reconciliation, dirty-region derivation, gap
 * detection) — can be tested in Node with no browser at all.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ClientState, type Effect } from '../client/state.js';
import type { ClearOp, ServerMessage, StrokeOp, User } from '../shared/protocol.js';
import { LIMITS, PROTOCOL_VERSION } from '../shared/protocol.js';

const me: User = { id: 'me-0001', name: 'Me', color: '#3b9ef5' };
const them: User = { id: 'them-0002', name: 'Them', color: '#e8453c' };

function strokeOp(seq: number, userId = them.id, overrides: Partial<StrokeOp> = {}): StrokeOp {
  return {
    kind: 'stroke',
    id: `${userId}-s${seq}`,
    seq,
    userId,
    ts: 1000 + seq,
    style: { color: '#112233', width: 4, tool: 'brush' },
    pts: [10 * seq, 10 * seq, 10 * seq + 20, 10 * seq + 20],
    bbox: [10 * seq - 3, 10 * seq - 3, 10 * seq + 23, 10 * seq + 23],
    undone: false,
    ...overrides,
  };
}

function clearOp(seq: number, userId = them.id): ClearOp {
  return { kind: 'clear', id: `${userId}-c${seq}`, seq, userId, ts: 1000 + seq, undone: false };
}

function welcome(over: Partial<Extract<ServerMessage, { t: 'welcome' }>> = {}): ServerMessage {
  return {
    t: 'welcome',
    v: PROTOCOL_VERSION,
    room: 'unit',
    you: me,
    users: [me, them],
    ops: [],
    live: [],
    seq: 0,
    hv: 0,
    partial: false,
    limits: LIMITS,
    serverTime: 1,
    ...over,
  };
}

const kinds = (effects: Effect[]): string[] => effects.map((e) => e.kind);

function joined(): ClientState {
  const state = new ClientState();
  state.apply(welcome());
  return state;
}

describe('welcome', () => {
  it('adopts identity, roster and limits', () => {
    const state = new ClientState();
    const effects = state.apply(welcome({ ops: [strokeOp(1), strokeOp(2)], seq: 2, hv: 2 }));
    assert.deepEqual(kinds(effects), ['identity', 'presence', 'repaintAll', 'cursors']);
    assert.equal(state.selfId, me.id);
    assert.equal(state.users.size, 2);
    assert.equal(state.log.size, 2);
    assert.equal(state.since, 2);
    assert.equal(state.serverHv, 2);
  });

  it('replaces the log on a full snapshot', () => {
    const state = joined();
    state.apply({ t: 'commit', sid: 'x', op: strokeOp(1), hv: 1 });
    assert.equal(state.log.size, 1);
    state.apply(welcome({ ops: [strokeOp(7)], seq: 7, hv: 9 }));
    assert.equal(state.log.size, 1);
    assert.equal(state.log.ops[0]!.seq, 7, 'the old op is gone, not merged');
  });

  it('merges a delta and repairs the visibility of older ops', () => {
    const state = joined();
    const first = strokeOp(1);
    const second = strokeOp(2);
    state.apply({ t: 'commit', sid: first.id, op: first, hv: 1 });
    state.apply({ t: 'commit', sid: second.id, op: second, hv: 2 });

    // Reconnect: op 3 is new, and op 1 was undone while we were away.
    state.apply(welcome({ ops: [strokeOp(3)], partial: true, undone: [first.id], seq: 3, hv: 8 }));
    assert.equal(state.log.size, 3);
    assert.equal(state.log.get(first.id)!.undone, true);
    assert.equal(state.log.get(second.id)!.undone, false, 'not in the undone set, so visible');
    assert.deepEqual(
      state.log.visibleStrokes().map((o) => o.seq),
      [2, 3],
    );
  });

  it('keeps our own unconfirmed strokes across a resync', () => {
    const state = joined();
    state.addOwnLive({ sid: 'me-0001-a', userId: me.id, style: { color: '#000000', width: 2, tool: 'brush' }, pts: [0, 0] });
    state.apply(welcome({ live: [{ sid: 'them-0002-b', userId: them.id, style: { color: '#ff0000', width: 2, tool: 'brush' }, pts: [5, 5] }] }));
    assert.ok(state.live.has('me-0001-a'), 'our in-flight stroke survived the snapshot');
    assert.ok(state.live.has('them-0002-b'), 'and theirs was adopted');
    assert.deepEqual([...state.ownPending], ['me-0001-a']);
  });

  it('drops a stale remote live stroke on resync', () => {
    const state = joined();
    state.apply({ t: 'begin', sid: 'them-0002-old', userId: them.id, style: { color: '#ff0000', width: 2, tool: 'brush' }, pts: [1, 1] });
    assert.equal(state.live.size, 1);
    state.apply(welcome());
    assert.equal(state.live.size, 0, 'the server says nothing is in flight');
  });
});

describe('live strokes', () => {
  it('reports a dirty box covering the new segment plus the smoothing join', () => {
    const state = joined();
    const begin = state.apply({
      t: 'begin',
      sid: 'them-0002-l',
      userId: them.id,
      style: { color: '#ff0000', width: 10, tool: 'brush' },
      pts: [100, 100],
    });
    assert.deepEqual(kinds(begin), ['live']);
    assert.deepEqual((begin[0] as { dirty: number[] }).dirty, [94, 94, 106, 106]);

    const more = state.apply({ t: 'points', sid: 'them-0002-l', userId: them.id, pts: [140, 100] });
    const dirty = (more[0] as { dirty: number[] }).dirty;
    assert.deepEqual(dirty, [94, 94, 146, 106], 'includes the previous point, not just the new one');
    assert.deepEqual(state.live.get('them-0002-l')!.pts, [100, 100, 140, 100]);
  });

  it('ignores points for an unknown stroke', () => {
    const state = joined();
    assert.deepEqual(state.apply({ t: 'points', sid: 'ghost', userId: them.id, pts: [1, 1] }), []);
  });

  it('promotes a live stroke on commit and dirties both shapes', () => {
    const state = joined();
    state.apply({
      t: 'begin',
      sid: 'them-0002-p',
      userId: them.id,
      style: { color: '#ff0000', width: 4, tool: 'brush' },
      pts: [0, 0, 50, 50],
    });
    const op = strokeOp(1, them.id, { id: 'them-0002-p', pts: [0, 0, 50, 50], bbox: [-3, -3, 53, 53] });
    const effects = state.apply({ t: 'commit', sid: op.id, op, hv: 1 });
    assert.deepEqual(kinds(effects), ['commit']);
    const dirty = (effects[0] as { dirty: number[] }).dirty;
    // Union of the prediction's bounds and the canonical op's bounds.
    assert.deepEqual(dirty, [-3, -3, 53, 53]);
    assert.equal(state.live.size, 0);
    assert.equal(state.log.size, 1);
  });

  it('is idempotent when a commit is replayed', () => {
    const state = joined();
    const op = strokeOp(1);
    state.apply({ t: 'commit', sid: op.id, op, hv: 1 });
    const again = state.apply({ t: 'commit', sid: op.id, op, hv: 1 });
    assert.equal(state.log.size, 1);
    assert.deepEqual(kinds(again), ['live'], 'no second rasterisation is requested');
  });

  it('clears the live remnant on cancel', () => {
    const state = joined();
    state.apply({
      t: 'begin',
      sid: 'them-0002-c',
      userId: them.id,
      style: { color: '#ff0000', width: 6, tool: 'brush' },
      pts: [200, 200],
    });
    const effects = state.apply({ t: 'cancel', sid: 'them-0002-c', userId: them.id });
    assert.deepEqual(kinds(effects), ['live']);
    assert.deepEqual((effects[0] as { dirty: number[] }).dirty, [196, 196, 204, 204]);
    assert.equal(state.live.size, 0);
  });

  it('tracks our own unconfirmed strokes', () => {
    const state = joined();
    state.addOwnLive({ sid: 'me-0001-x', userId: me.id, style: { color: '#000000', width: 2, tool: 'brush' }, pts: [1, 1] });
    assert.equal(state.unconfirmed().length, 1);
    const op = strokeOp(1, me.id, { id: 'me-0001-x' });
    state.apply({ t: 'commit', sid: op.id, op, hv: 1 });
    assert.equal(state.unconfirmed().length, 0, 'the commit cleared the pending flag');
  });
});

describe('visibility changes', () => {
  it('asks for a region repaint covering exactly the undone stroke', () => {
    const state = joined();
    const op = strokeOp(1);
    state.apply({ t: 'commit', sid: op.id, op, hv: 1 });
    const effects = state.apply({
      t: 'vis',
      changes: [{ id: op.id, undone: true }],
      by: them.id,
      action: 'undo',
      hv: 2,
      seq: 1,
    });
    assert.deepEqual(kinds(effects), ['region']);
    assert.deepEqual((effects[0] as { bbox: number[] }).bbox, op.bbox);
    assert.equal(state.log.get(op.id)!.undone, true);
  });

  it('repaints everything for a clear, and again when the clear is undone', () => {
    const state = joined();
    const op = strokeOp(1);
    state.apply({ t: 'commit', sid: op.id, op, hv: 1 });
    const clear = clearOp(2);
    const cleared = state.apply({ t: 'vis', changes: [], op: clear, by: them.id, action: 'clear', hv: 2, seq: 2 });
    assert.deepEqual(kinds(cleared), ['repaintAll']);
    assert.equal(state.log.visibleStrokes().length, 0);

    const undone = state.apply({
      t: 'vis',
      changes: [{ id: clear.id, undone: true }],
      by: me.id,
      action: 'undo',
      hv: 3,
      seq: 2,
    });
    assert.deepEqual(kinds(undone), ['repaintAll'], 'a clear affects the whole surface');
    assert.equal(state.log.visibleStrokes().length, 1);
  });

  it('falls back to a full repaint when the changed op is unknown', () => {
    const state = joined();
    const effects = state.apply({
      t: 'vis',
      changes: [{ id: 'never-seen', undone: true }],
      by: them.id,
      action: 'undo',
      hv: 1,
      seq: 5,
    });
    assert.deepEqual(kinds(effects), ['repaintAll']);
  });

  it('unions the regions of a multi-op change', () => {
    const state = joined();
    const a = strokeOp(1);
    const b = strokeOp(5);
    state.apply({ t: 'commit', sid: a.id, op: a, hv: 1 });
    state.apply({ t: 'commit', sid: b.id, op: b, hv: 2 });
    const effects = state.apply({
      t: 'vis',
      changes: [
        { id: a.id, undone: true },
        { id: b.id, undone: true },
      ],
      by: me.id,
      action: 'undo',
      hv: 3,
      seq: 5,
    });
    assert.deepEqual((effects[0] as { bbox: number[] }).bbox, [7, 7, 73, 73]);
  });
});

describe('history gap detection', () => {
  it('stays quiet while history versions arrive in order', () => {
    const state = joined();
    const a = strokeOp(1);
    const b = strokeOp(2);
    assert.deepEqual(kinds(state.apply({ t: 'commit', sid: a.id, op: a, hv: 1 })), ['commit']);
    assert.deepEqual(kinds(state.apply({ t: 'commit', sid: b.id, op: b, hv: 2 })), ['commit']);
  });

  it('flags a jump so the caller can resync', () => {
    const state = joined();
    const op = strokeOp(4);
    const effects = state.apply({ t: 'commit', sid: op.id, op, hv: 4 });
    assert.deepEqual(kinds(effects), ['gap', 'commit']);
    const gap = effects[0] as { expected: number; got: number };
    assert.equal(gap.expected, 1);
    assert.equal(gap.got, 4);
    assert.equal(state.serverHv, 4, 'and resyncs from the new version');
  });

  it('does not flag the version staying put', () => {
    const state = joined();
    const op = strokeOp(1);
    state.apply({ t: 'commit', sid: op.id, op, hv: 1 });
    const replay = state.apply({ t: 'commit', sid: op.id, op, hv: 1 });
    assert.ok(!kinds(replay).includes('gap'));
  });
});

describe('presence', () => {
  it('adds and removes users', () => {
    const state = joined();
    const third: User = { id: 'third-0003', name: 'Third', color: '#3fb950' };
    assert.deepEqual(kinds(state.apply({ t: 'join', user: third })), ['presence']);
    assert.equal(state.users.size, 3);
    assert.deepEqual(kinds(state.apply({ t: 'leave', userId: third.id })), ['presence', 'cursors', 'live']);
    assert.equal(state.users.size, 2);
  });

  it('drops a departing user\'s cursor and in-flight strokes', () => {
    const state = joined();
    state.apply({ t: 'cursor', userId: them.id, x: 5, y: 5, active: true });
    state.apply({
      t: 'begin',
      sid: 'them-0002-gone',
      userId: them.id,
      style: { color: '#ff0000', width: 8, tool: 'brush' },
      pts: [300, 300],
    });
    const effects = state.apply({ t: 'leave', userId: them.id });
    assert.equal(state.cursors.size, 0);
    assert.equal(state.live.size, 0);
    const live = effects.find((e) => e.kind === 'live') as { dirty: number[] | null };
    assert.deepEqual(live.dirty, [295, 295, 305, 305], 'their abandoned stroke area is repainted');
  });

  it('applies a rename to the roster and to self', () => {
    const state = joined();
    state.apply({ t: 'rename', userId: them.id, name: 'Renamed' });
    assert.equal(state.userName(them.id), 'Renamed');
    state.apply({ t: 'rename', userId: me.id, name: 'I Am' });
    assert.equal(state.self!.name, 'I Am');
  });

  it('falls back gracefully for an unknown user', () => {
    const state = joined();
    assert.equal(state.userName('nobody'), 'Someone');
    assert.match(state.userColor('nobody'), /^#[0-9a-f]{6}$/);
  });

  it('records cursor positions with a local timestamp', () => {
    const state = joined();
    assert.deepEqual(kinds(state.apply({ t: 'cursor', userId: them.id, x: 12, y: 34, active: true })), ['cursors']);
    const cursor = state.cursors.get(them.id)!;
    assert.equal(cursor.x, 12);
    assert.equal(cursor.active, true);
    assert.ok(cursor.at > 0);
  });
});

describe('notices and unknown messages', () => {
  it('surfaces server errors as notices', () => {
    const state = joined();
    const effects = state.apply({ t: 'error', code: 'nothing_to_undo', message: 'Nothing to undo.' });
    assert.deepEqual(effects, [{ kind: 'notice', code: 'nothing_to_undo', message: 'Nothing to undo.', fatal: false }]);
  });

  it('marks fatal errors as such', () => {
    const state = joined();
    const effects = state.apply({ t: 'error', code: 'version_mismatch', message: 'Reload.', fatal: true });
    assert.equal((effects[0] as { fatal: boolean }).fatal, true);
  });

  it('ignores transport-level messages', () => {
    const state = joined();
    assert.deepEqual(state.apply({ t: 'pong', ts: 1, serverTime: 2 }), []);
    assert.deepEqual(state.apply({ t: 'reconnect', reason: 'window_expired' }), []);
  });
});
