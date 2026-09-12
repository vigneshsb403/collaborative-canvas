/**
 * End-to-end WebSocket tests against a real server on an ephemeral port.
 * Nothing is stubbed: `ws` client -> TCP -> Express/`ws` server -> Hub.
 */

// Keep the server's join/leave logging out of the test output.
process.env.QUIET_LOGS = '1';

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { LIMITS, PROTOCOL_VERSION } from '../shared/protocol.js';
import { drawStroke, line, newClientId, startHarness, until, WsClient, type Harness } from './helpers.js';

let h: Harness;
let roomSeq = 0;
const room = (): string => `it-ws-${++roomSeq}`;

before(async () => {
  h = await startHarness();
});

after(async () => {
  await h.close();
});

function client(label = 'u'): WsClient {
  return new WsClient(h.port, newClientId(label));
}

describe('handshake and presence', () => {
  it('welcomes a new client with identity, limits and an empty log', async () => {
    const a = client();
    const welcome = await a.hello(room());
    assert.equal(welcome.v, PROTOCOL_VERSION);
    assert.match(welcome.you.color, /^#[0-9a-f]{6}$/);
    assert.ok(welcome.you.name.length > 0);
    assert.deepEqual(welcome.ops, []);
    assert.equal(welcome.partial, false);
    assert.deepEqual(welcome.limits, LIMITS);
    assert.deepEqual(welcome.users.map((u) => u.id), [welcome.you.id]);
    await a.close();
  });

  it('gives concurrent users distinct colours and tells everyone who joined', async () => {
    const r = room();
    const a = client('alice');
    const b = client('bob');
    const wa = await a.hello(r);
    const wb = await b.hello(r);

    assert.notEqual(wa.you.color, wb.you.color, 'colours must differ');
    assert.notEqual(wa.you.name, wb.you.name, 'names must differ');
    assert.equal(wb.users.length, 2, 'b sees both members on arrival');

    const join = await a.waitForType('join');
    assert.equal(join.user.id, wb.you.id);
    await Promise.all([a.close(), b.close()]);
  });

  it('accepts a custom display name and broadcasts a rename', async () => {
    const r = room();
    const a = client('alice');
    const b = client('bob');
    const wa = await a.hello(r, { name: '  Vignesh   SB  ' });
    assert.equal(wa.you.name, 'Vignesh SB', 'whitespace is collapsed');
    await b.hello(r);

    a.send({ t: 'rename', name: 'Renamed' });
    const ren = await b.waitForType('rename');
    assert.equal(ren.userId, wa.you.id);
    assert.equal(ren.name, 'Renamed');
    await Promise.all([a.close(), b.close()]);
  });

  it('announces a departure', async () => {
    const r = room();
    const a = client('alice');
    const b = client('bob');
    await a.hello(r);
    const wb = await b.hello(r);
    await b.close();
    const leave = await a.waitForType('leave');
    assert.equal(leave.userId, wb.you.id);
    await a.close();
  });

  it('restores colour and name when the same clientId reconnects', async () => {
    const r = room();
    const id = newClientId('sticky');
    const first = new WsClient(h.port, id);
    const w1 = await first.hello(r, { name: 'Sticky' });
    await first.close();

    const second = new WsClient(h.port, id);
    const w2 = await second.hello(r);
    assert.equal(w2.you.id, w1.you.id);
    assert.equal(w2.you.color, w1.you.color, 'presence colour survives a reconnect');
    assert.equal(w2.you.name, 'Sticky', 'display name survives a reconnect');
    await second.close();
  });

  it('supersedes an older connection using the same identity', async () => {
    const r = room();
    const id = newClientId('twin');
    const first = new WsClient(h.port, id);
    await first.hello(r);
    const second = new WsClient(h.port, id);
    await second.hello(r);

    const err = await first.waitForType('error');
    assert.equal(err.code, 'superseded');
    assert.equal(err.fatal, true);
    await until(() => first.closedCode !== null, 2000, 'first socket to close');

    // The room still has exactly one member, and it is the new connection.
    const witness = client('witness');
    const w = await witness.hello(r);
    assert.equal(w.users.length, 2, 'no phantom duplicate member');
    await Promise.all([second.close(), witness.close()]);
  });
});

describe('live stroke streaming', () => {
  it('streams a stroke to peers before it is finished, then commits it', async () => {
    const r = room();
    const a = client('alice');
    const b = client('bob');
    const wa = await a.hello(r);
    await b.hello(r);
    b.clearReceived();

    const sid = `${wa.you.id}-live1`;
    const style = { color: '#ff8800', width: 6, tool: 'brush' as const };
    a.send({ t: 'begin', sid, style, pts: [10, 10, 20, 20] });
    const begin = await b.waitForType('begin');
    assert.equal(begin.sid, sid);
    assert.equal(begin.userId, wa.you.id);
    assert.deepEqual(begin.style, style);
    assert.deepEqual(begin.pts, [10, 10, 20, 20]);

    a.send({ t: 'points', sid, pts: [40, 40, 60, 30] });
    const pts = await b.waitForType('points');
    assert.deepEqual(pts.pts, [40, 40, 60, 30]);

    // The peer saw the stroke mid-flight — before any commit arrived.
    assert.equal(b.ofType('commit').length, 0, 'nothing committed yet');

    a.send({ t: 'end', sid, n: 4 });
    const commit = await b.waitForType('commit');
    assert.equal(commit.op.id, sid);
    assert.equal(commit.op.seq, 1);
    assert.equal(commit.op.userId, wa.you.id);
    assert.equal(commit.op.undone, false);
    // Points span (10,10)-(60,40); width 6 pads by 3 plus 1 unit of AA slop.
    assert.deepEqual(commit.op.bbox, [6, 6, 64, 44], 'bounds cover the path plus half the width');

    // The author gets the canonical op too, so it can reconcile its prediction.
    const own = await a.waitForType('commit');
    assert.deepEqual(own.op, commit.op);

    // Ordering guarantee that makes live rendering possible.
    assert.deepEqual(
      b.received.map((m) => m.t),
      ['begin', 'points', 'commit'],
    );
    await Promise.all([a.close(), b.close()]);
  });

  it('does not echo a stroke back to its author before commit', async () => {
    const r = room();
    const a = client('alice');
    const wa = await a.hello(r);
    a.clearReceived();
    const sid = `${wa.you.id}-echo`;
    a.send({ t: 'begin', sid, style: { color: '#000000', width: 2, tool: 'brush' }, pts: [1, 1] });
    a.send({ t: 'points', sid, pts: [20, 20] });
    a.send({ t: 'end', sid, n: 2 });
    await a.waitForType('commit');
    assert.deepEqual(a.ofType('begin'), [], 'author renders its own stroke locally');
    assert.deepEqual(a.ofType('points'), []);
    await a.close();
  });

  it('canonicalises the committed path by simplifying it', async () => {
    const r = room();
    const a = client('alice');
    await a.hello(r);
    const commit = await drawStroke(a, { points: line(0, 0, 100, 0, 30), chunks: 3 });
    assert.deepEqual(commit.op.pts, [0, 0, 100, 0], 'a straight line collapses to two points');
    await a.close();
  });

  it('hands a newcomer both the committed log and the strokes in flight', async () => {
    const r = room();
    const a = client('alice');
    const wa = await a.hello(r);
    const done = await drawStroke(a, { points: line(0, 0, 50, 90, 6) });

    const sid = `${wa.you.id}-inflight`;
    a.send({ t: 'begin', sid, style: { color: '#00ff00', width: 3, tool: 'brush' }, pts: [200, 200, 240, 260] });
    // Make sure the server processed the begin before the newcomer joins.
    await drawStroke(a, { points: line(300, 300, 310, 310, 3) });

    const c = client('carol');
    const wc = await c.hello(r);
    assert.equal(wc.ops.length, 2, 'two committed strokes');
    assert.ok(wc.ops.some((op) => op.id === done.op.id));
    assert.equal(wc.live.length, 1, 'one stroke still being drawn');
    assert.equal(wc.live[0]!.sid, sid);
    assert.deepEqual(wc.live[0]!.pts, [200, 200, 240, 260]);
    await Promise.all([a.close(), c.close()]);
  });

  it('cancels in-flight strokes when their author vanishes without a close frame', async () => {
    const r = room();
    const a = client('alice');
    const b = client('bob');
    const wa = await a.hello(r);
    await b.hello(r);
    const sid = `${wa.you.id}-abandoned`;
    a.send({ t: 'begin', sid, style: { color: '#000000', width: 2, tool: 'brush' }, pts: [5, 5, 9, 9] });
    await b.waitForType('begin');

    a.kill(); // simulated network drop, no close handshake

    const cancel = await b.waitFor((m) => m.t === 'cancel' && m.sid === sid, 4000, 'cancel');
    assert.equal(cancel.t, 'cancel');
    await b.waitForType('leave');
    await b.close();
  });

  it('treats an explicit cancel as a no-op when there is nothing to cancel', async () => {
    const r = room();
    const a = client('alice');
    const wa = await a.hello(r);
    a.clearReceived();
    a.send({ t: 'cancel', sid: `${wa.you.id}-never` });
    a.send({ t: 'ping', ts: 7 });
    const pong = await a.waitForType('pong');
    assert.equal(pong.ts, 7);
    assert.deepEqual(a.ofType('error'), [], 'a redundant cancel is not an error');
    await a.close();
  });

  it('converts a click that never moved into a dot, not an error', async () => {
    const r = room();
    const a = client('alice');
    const wa = await a.hello(r);
    const sid = `${wa.you.id}-dot`;
    a.send({ t: 'begin', sid, style: { color: '#000000', width: 8, tool: 'brush' }, pts: [77, 88] });
    a.send({ t: 'end', sid, n: 1 });
    const commit = await a.waitForType('commit');
    assert.deepEqual(commit.op.pts, [77, 88]);
    await a.close();
  });
});

describe('cursors', () => {
  it('relays cursor positions to peers but never back to the sender', async () => {
    const r = room();
    const a = client('alice');
    const b = client('bob');
    const wa = await a.hello(r);
    await b.hello(r);
    a.clearReceived();

    a.send({ t: 'cursor', x: 123.456, y: 78.9, active: true });
    const cursor = await b.waitForType('cursor');
    assert.equal(cursor.userId, wa.you.id);
    assert.equal(cursor.x, 123.5, 'quantised to one decimal');
    assert.equal(cursor.y, 78.9);
    assert.equal(cursor.active, true);
    assert.deepEqual(a.ofType('cursor'), []);
    await Promise.all([a.close(), b.close()]);
  });

  it('throttles a cursor flood instead of forwarding every sample', async () => {
    const r = room();
    const a = client('alice');
    const b = client('bob');
    await a.hello(r);
    await b.hello(r);
    b.clearReceived();

    for (let i = 0; i < 60; i++) a.send({ t: 'cursor', x: i, y: i, active: false });
    await b.waitForType('cursor');
    a.send({ t: 'ping', ts: 1 });
    await a.waitForType('pong');

    assert.ok(b.ofType('cursor').length < 10, `expected heavy throttling, got ${b.ofType('cursor').length}`);
    assert.deepEqual(a.ofType('error'), [], 'cursor spam must not burn the rate-limit budget');
    await Promise.all([a.close(), b.close()]);
  });
});

describe('global undo / redo over the wire', () => {
  it('propagates an undo of somebody else\'s stroke to every client', async () => {
    const r = room();
    const a = client('alice');
    const b = client('bob');
    await a.hello(r);
    const wb = await b.hello(r);
    const commit = await drawStroke(a, { points: line(0, 0, 10, 10, 4) });

    b.send({ t: 'undo', scope: 'global' });
    const visA = await a.waitForType('vis');
    const visB = await b.waitForType('vis');
    assert.equal(visA.action, 'undo');
    assert.equal(visA.by, wb.you.id);
    assert.deepEqual(visA.changes, [{ id: commit.op.id, undone: true }]);
    assert.deepEqual(visB.changes, visA.changes, 'both sides get the identical change');
    assert.equal(visA.hv, visB.hv);

    a.send({ t: 'redo', scope: 'global' });
    const redo = await b.waitFor((m) => m.t === 'vis' && m.action === 'redo', 4000, 'redo');
    assert.equal(redo.t === 'vis' && redo.changes[0]!.undone, false);
    await Promise.all([a.close(), b.close()]);
  });

  it('resolves two simultaneous undos into two distinct ops', async () => {
    const r = room();
    const a = client('alice');
    const b = client('bob');
    await a.hello(r);
    await b.hello(r);
    const first = await drawStroke(a, { points: line(0, 0, 10, 10, 4) });
    const second = await drawStroke(b, { points: line(50, 50, 60, 60, 4) });
    a.clearReceived();

    // Both fire in the same tick; the server serialises them.
    a.send({ t: 'undo', scope: 'global' });
    b.send({ t: 'undo', scope: 'global' });

    await until(() => a.ofType('vis').length >= 2, 3000, 'two vis messages');
    const changed = a.ofType('vis').flatMap((m) => m.changes.map((c) => c.id));
    assert.deepEqual(new Set(changed), new Set([second.op.id, first.op.id]));
    assert.equal(changed.length, 2, 'no op was undone twice');
    await Promise.all([a.close(), b.close()]);
  });

  it('scopes "undo mine" to the caller\'s own strokes', async () => {
    const r = room();
    const a = client('alice');
    const b = client('bob');
    await a.hello(r);
    await b.hello(r);
    await drawStroke(a, { points: line(0, 0, 10, 10, 4) });
    const bobs = await drawStroke(b, { points: line(20, 20, 30, 30, 4) });
    const alices2 = await drawStroke(a, { points: line(40, 40, 50, 50, 4) });
    b.clearReceived();

    b.send({ t: 'undo', scope: 'mine' });
    const vis = await b.waitForType('vis');
    assert.deepEqual(vis.changes, [{ id: bobs.op.id, undone: true }], 'bob undid his own, not alice\'s latest');
    assert.notEqual(vis.changes[0]!.id, alices2.op.id);
    await Promise.all([a.close(), b.close()]);
  });

  it('reports "nothing to undo" as a non-fatal notice', async () => {
    const r = room();
    const a = client('alice');
    await a.hello(r);
    a.send({ t: 'undo', scope: 'global' });
    const err = await a.waitForType('error');
    assert.equal(err.code, 'nothing_to_undo');
    assert.notEqual(err.fatal, true);
    // The connection still works.
    a.send({ t: 'ping', ts: 42 });
    assert.equal((await a.waitForType('pong')).ts, 42);
    await a.close();
  });

  it('broadcasts a clear as an undoable op', async () => {
    const r = room();
    const a = client('alice');
    const b = client('bob');
    await a.hello(r);
    await b.hello(r);
    await drawStroke(a, { points: line(0, 0, 10, 10, 4) });
    b.clearReceived();

    a.send({ t: 'clear' });
    const vis = await b.waitForType('vis');
    assert.equal(vis.action, 'clear');
    assert.ok(vis.op !== undefined, 'the clear op itself is carried');
    assert.equal(vis.op!.kind, 'clear');

    b.send({ t: 'undo', scope: 'global' });
    const undo = await b.waitFor((m) => m.t === 'vis' && m.action === 'undo', 4000, 'undo of the clear');
    assert.equal(undo.t === 'vis' && undo.changes[0]!.id, vis.op!.id);
    assert.equal(undo.t === 'vis' && undo.changes[0]!.undone, true);
    await Promise.all([a.close(), b.close()]);
  });

  it('refuses to clear an already empty canvas', async () => {
    const r = room();
    const a = client('alice');
    await a.hello(r);
    a.send({ t: 'clear' });
    assert.equal((await a.waitForType('error')).code, 'already_clear');
    await a.close();
  });
});

describe('reconnect and resync', () => {
  it('sends only the delta, plus the visibility of older ops', async () => {
    const r = room();
    const id = newClientId('rejoin');
    const a = new WsClient(h.port, id);
    const b = client('bob');
    await a.hello(r);
    await b.hello(r);
    const first = await drawStroke(a, { points: line(0, 0, 10, 10, 4) });
    const second = await drawStroke(a, { points: line(20, 20, 30, 30, 4) });
    await a.close();

    // While A is away: B undoes A's first stroke and draws one of their own.
    b.send({ t: 'undo', scope: 'global' });
    await b.waitForType('vis');
    b.send({ t: 'undo', scope: 'global' });
    await until(() => b.ofType('vis').length >= 2, 2000, 'second undo');
    const third = await drawStroke(b, { points: line(70, 70, 90, 90, 4) });

    const back = new WsClient(h.port, id);
    const w = await back.hello(r, { since: second.op.seq });
    assert.equal(w.partial, true, 'a delta, not a full snapshot');
    assert.deepEqual(w.ops.map((o) => o.id), [third.op.id], 'only the op we missed');
    assert.deepEqual(new Set(w.undone), new Set([first.op.id, second.op.id]), 'visibility of older ops is repaired');
    assert.equal(w.seq, third.op.seq);
    await Promise.all([back.close(), b.close()]);
  });

  it('falls back to a full snapshot when the delta would be most of the log', async () => {
    const r = room();
    const a = client('alice');
    await a.hello(r);
    for (let i = 0; i < 4; i++) await drawStroke(a, { points: line(i, 0, i + 5, 9, 3) });

    const b = client('bob');
    const w = await b.hello(r, { since: 1 });
    assert.equal(w.partial, false, '3 of 4 ops is past the delta threshold');
    assert.equal(w.ops.length, 4);
    assert.equal(w.undone, undefined);
    await Promise.all([a.close(), b.close()]);
  });

  it('serves an explicit resync request', async () => {
    const r = room();
    const a = client('alice');
    await a.hello(r);
    const commit = await drawStroke(a, { points: line(0, 0, 9, 9, 3) });
    a.clearReceived();
    a.send({ t: 'resync', since: 0 });
    const sync = await a.waitForType('sync');
    assert.equal(sync.partial, false);
    assert.deepEqual(sync.ops.map((o) => o.id), [commit.op.id]);
    assert.equal(sync.seq, commit.op.seq);
    await a.close();
  });

  it('keeps the drawing when everyone leaves and someone comes back', async () => {
    const r = room();
    const a = client('alice');
    await a.hello(r);
    const commit = await drawStroke(a, { points: line(0, 0, 9, 9, 3) });
    await a.close();
    await until(() => h.server.registry.peek(r)?.size === 0, 2000, 'room to empty');

    const b = client('bob');
    const w = await b.hello(r);
    assert.deepEqual(w.ops.map((o) => o.id), [commit.op.id], 'the canvas survived an empty room');
    await b.close();
  });
});

describe('protocol hardening', () => {
  it('rejects a wrong protocol version with a fatal error', async () => {
    const a = client();
    await a.ready();
    a.send({ t: 'hello', room: room(), clientId: a.clientId, v: 999 });
    const err = await a.waitForType('error');
    assert.equal(err.code, 'version_mismatch');
    assert.equal(err.fatal, true);
    await until(() => a.closedCode !== null, 2000, 'socket close');
  });

  it('rejects a malformed clientId', async () => {
    const a = new WsClient(h.port, 'no');
    await a.ready();
    a.send({ t: 'hello', room: room(), clientId: 'no', v: PROTOCOL_VERSION });
    assert.equal((await a.waitForType('error')).code, 'bad_client_id');
    await a.close();
  });

  it('refuses everything before hello', async () => {
    const a = client();
    await a.ready();
    a.send({ t: 'ping', ts: 1 });
    assert.equal((await a.waitForType('error')).code, 'not_joined');
    await a.close();
  });

  it('rejects a second hello on the same connection', async () => {
    const r = room();
    const a = client();
    await a.hello(r);
    a.send({ t: 'hello', room: r, clientId: a.clientId, v: PROTOCOL_VERSION });
    assert.equal((await a.waitForType('error')).code, 'already_joined');
    await a.close();
  });

  it('survives malformed JSON and unknown message types', async () => {
    const r = room();
    const a = client();
    await a.hello(r);
    a.sendRaw('{not json');
    assert.equal((await a.waitForType('error')).code, 'bad_json');

    const b = client();
    await b.hello(r);
    b.sendRaw(JSON.stringify({ t: 'launch-missiles' }));
    assert.equal((await b.waitForType('error')).code, 'unknown_type');

    b.sendRaw('"a bare string"');
    await until(() => b.ofType('error').length >= 2, 2000, 'second error');
    assert.equal(b.ofType('error')[1]!.code, 'bad_message');
    await Promise.all([a.close(), b.close()]);
  });

  it('rejects a point list beyond the per-stroke cap', async () => {
    const r = room();
    const a = client();
    const w = await a.hello(r);
    const huge: number[] = [];
    for (let i = 0; i < LIMITS.maxPointsPerStroke + 10; i++) huge.push(i % 900, (i * 7) % 900);
    a.send({ t: 'begin', sid: `${w.you.id}-huge`, style: { color: '#000000', width: 2, tool: 'brush' }, pts: huge });
    assert.equal((await a.waitForType('error')).code, 'bad_points');
    await a.close();
  });

  it('closes a connection that sends an oversized frame', async () => {
    const r = room();
    const a = client();
    await a.hello(r);
    a.sendRaw(JSON.stringify({ t: 'rename', name: 'x'.repeat(200_000) }));
    await until(() => a.closedCode !== null, 3000, 'socket to be closed');
    assert.ok(a.closedCode === 1009 || a.closedCode === 1000, `unexpected close code ${a.closedCode}`);
  });

  it('rate-limits a flood without dropping the connection', async () => {
    const r = room();
    const a = client();
    await a.hello(r);
    for (let i = 0; i < 400; i++) a.send({ t: 'ping', ts: i });
    const err = await a.waitFor((m) => m.t === 'error' && m.code === 'rate_limited', 4000, 'rate limit notice');
    assert.equal(err.t === 'error' && err.fatal, undefined);
    assert.equal(a.closedCode, null, 'a burst is throttled, not fatal');
    await a.close();
  });

  it('ignores binary frames', async () => {
    const r = room();
    const a = client();
    await a.hello(r);
    await a.ready();
    const err = await (async () => {
      (a as unknown as { socket: { send(d: Buffer): void } }).socket.send(Buffer.from([1, 2, 3]));
      return a.waitForType('error');
    })();
    assert.equal(err.code, 'bad_message');
    await a.close();
  });

  it('isolates rooms from each other', async () => {
    const a = client('alice');
    const b = client('bob');
    await a.hello(room());
    await b.hello(room());
    await drawStroke(a, { points: line(0, 0, 9, 9, 3) });
    b.send({ t: 'ping', ts: 1 });
    await b.waitForType('pong');
    assert.deepEqual(b.ofType('commit'), [], 'no cross-room leakage');
    assert.deepEqual(b.ofType('join'), []);
    await Promise.all([a.close(), b.close()]);
  });

  it('normalises an odd room name instead of erroring', async () => {
    const a = client();
    const w = await a.hello('  Weird Room!! ');
    assert.equal(w.room, 'weirdroom');
    await a.close();
  });

  it('answers the health endpoint', async () => {
    const res = await fetch(`http://127.0.0.1:${h.port}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; protocol: number; rooms: number };
    assert.equal(body.ok, true);
    assert.equal(body.protocol, PROTOCOL_VERSION);
    assert.ok(body.rooms >= 1);
  });
});
