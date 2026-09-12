/**
 * End-to-end tests for the serverless transport (SSE downstream + POST
 * upstream) — the one Vercel actually runs.
 *
 * The stream window is shortened to 1.5s here so the "window expired, reopen"
 * path (which on Vercel happens every ~50s) is exercised for real. The env var
 * has to be set before `server/serverless.ts` is evaluated, hence the dynamic
 * import.
 */

// Keep the server's join/leave logging out of the test output.
process.env.QUIET_LOGS = '1';

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { PROTOCOL_VERSION } from '../shared/protocol.js';

process.env.SSE_TTL_MS = '1500';

const { drawStroke, line, newClientId, SseClient, startHarness, until, WsClient } = await import('./helpers.js');
type Harness = Awaited<ReturnType<typeof startHarness>>;

let h: Harness;
let roomSeq = 0;
const room = (): string => `it-sse-${++roomSeq}`;

before(async () => {
  h = await startHarness();
});

after(async () => {
  await h.close();
});

describe('SSE transport', () => {
  it('treats opening the stream as the join and replies with a welcome', async () => {
    const c = new SseClient(h.port, newClientId('sse'));
    const w = await c.open(room(), { name: 'Streamer' });
    assert.equal(w.v, PROTOCOL_VERSION);
    assert.equal(w.you.name, 'Streamer');
    assert.match(w.you.color, /^#[0-9a-f]{6}$/);
    await c.close();
  });

  it('carries a full stroke upstream through POST batches', async () => {
    const r = room();
    const c = new SseClient(h.port, newClientId('sse'));
    const w = await c.open(r);
    const sid = `${w.you.id}-p1`;

    const res = await c.post(
      { t: 'begin', sid, style: { color: '#00aaff', width: 5, tool: 'brush' }, pts: [0, 0] },
      { t: 'points', sid, pts: [30, 30, 60, 0] },
      { t: 'end', sid, n: 3 },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, handled: 3 });

    const commit = await c.waitForType('commit');
    assert.equal(commit.op.id, sid);
    assert.equal(commit.op.seq, 1);
    assert.deepEqual(commit.op.pts, [0, 0, 30, 30, 60, 0]);
    await c.close();
  });

  it('shares a room with a WebSocket client — both transports, one canvas', async () => {
    const r = room();
    const ws = new WsClient(h.port, newClientId('wsuser'));
    const sse = new SseClient(h.port, newClientId('sseuser'));
    const wsWelcome = await ws.hello(r);
    const sseWelcome = await sse.open(r);
    assert.equal(sseWelcome.users.length, 2);

    // WebSocket user draws; SSE user must see it live and then committed.
    const wsSid = `${wsWelcome.you.id}-x1`;
    ws.send({ t: 'begin', sid: wsSid, style: { color: '#ff0000', width: 3, tool: 'brush' }, pts: [5, 5] });
    const begin = await sse.waitForType('begin');
    assert.equal(begin.sid, wsSid);
    ws.send({ t: 'points', sid: wsSid, pts: [50, 50] });
    await sse.waitForType('points');
    ws.send({ t: 'end', sid: wsSid, n: 2 });
    const commitOnSse = await sse.waitForType('commit');

    // SSE user draws; WebSocket user must see it too.
    const sseSid = `${sseWelcome.you.id}-y1`;
    await sse.post(
      { t: 'begin', sid: sseSid, style: { color: '#0000ff', width: 3, tool: 'brush' }, pts: [100, 100] },
      { t: 'points', sid: sseSid, pts: [140, 160] },
      { t: 'end', sid: sseSid, n: 2 },
    );
    const commitOnWs = await ws.waitFor((m) => m.t === 'commit' && m.sid === sseSid, 4000, 'sse stroke commit');
    assert.equal(commitOnWs.t === 'commit' && commitOnWs.op.seq, 2);

    // And a global undo from the SSE side reaches the WebSocket side.
    await sse.post({ t: 'undo', scope: 'global' });
    const vis = await ws.waitForType('vis');
    assert.equal(vis.changes[0]!.id, sseSid, 'the newest op is undone first');
    assert.equal(commitOnSse.op.id, wsSid);

    await Promise.all([ws.close(), sse.close()]);
  });

  it('relays cursors between transports', async () => {
    const r = room();
    const ws = new WsClient(h.port, newClientId('wsuser'));
    const sse = new SseClient(h.port, newClientId('sseuser'));
    await ws.hello(r);
    const w = await sse.open(r);
    await sse.post({ t: 'cursor', x: 12.34, y: 56.78, active: true });
    const cursor = await ws.waitForType('cursor');
    assert.equal(cursor.userId, w.you.id);
    assert.equal(cursor.x, 12.3);
    await Promise.all([ws.close(), sse.close()]);
  });

  it('asks the client to reopen before the platform kills the window', async () => {
    const r = room();
    const c = new SseClient(h.port, newClientId('expire'));
    await c.open(r);
    const msg = await c.waitForType('reconnect', 5000);
    assert.equal(msg.reason, 'window_expired');
    await until(() => c.streamEnded, 3000, 'stream to end');

    // A POST against the dead window is refused with a recoverable status.
    const res = await c.post({ t: 'ping', ts: 1 });
    assert.equal(res.status, 409);
    assert.deepEqual((res.body as { error: string }).error, 'no_stream');
  });

  it('resumes with a delta when the stream is reopened', async () => {
    const r = room();
    const id = newClientId('resume');
    const c = new SseClient(h.port, id, `stream-${id}`);
    const w1 = await c.open(r);
    const sid = `${w1.you.id}-keep`;
    await c.post(
      { t: 'begin', sid, style: { color: '#112233', width: 2, tool: 'brush' }, pts: [0, 0] },
      { t: 'points', sid, pts: [10, 40] },
      { t: 'end', sid, n: 2 },
    );
    const commit = await c.waitForType('commit');
    await c.close();

    // Reopen the same stream id, telling the server what we already have.
    const again = new SseClient(h.port, id, `stream-${id}`);
    const w2 = await again.open(r, { since: commit.op.seq });
    assert.equal(w2.partial, true);
    assert.deepEqual(w2.ops, [], 'nothing new happened while we were away');
    assert.equal(w2.you.id, w1.you.id, 'identity survives the reopen');
    assert.equal(w2.seq, commit.op.seq);

    // The reopened window accepts upstream traffic again.
    const res = await again.post({ t: 'ping', ts: 9 });
    assert.equal(res.status, 200);
    assert.equal((await again.waitForType('pong')).ts, 9);
    await again.close();
  });

  it('retires the previous window when a stream id is reopened', async () => {
    const r = room();
    const id = newClientId('reopen');
    const first = new SseClient(h.port, id, `dup-${id}`);
    await first.open(r);
    const second = new SseClient(h.port, id, `dup-${id}`);
    await second.open(r);
    await until(() => first.streamEnded, 3000, 'first window to be retired');

    // Presence must not show a duplicate.
    const witness = new WsClient(h.port, newClientId('witness'));
    const w = await witness.hello(r);
    assert.equal(w.users.length, 2, 'one SSE member plus the witness');
    await Promise.all([second.close(), witness.close()]);
  });

  it('drops the member and cancels live strokes when the stream aborts', async () => {
    const r = room();
    const ws = new WsClient(h.port, newClientId('watcher'));
    await ws.hello(r);
    const sse = new SseClient(h.port, newClientId('leaver'));
    const w = await sse.open(r);
    const sid = `${w.you.id}-abandon`;
    await sse.post({ t: 'begin', sid, style: { color: '#000000', width: 2, tool: 'brush' }, pts: [1, 1] });
    await ws.waitForType('begin');

    await sse.close();
    const cancel = await ws.waitFor((m) => m.t === 'cancel' && m.sid === sid, 4000, 'cancel');
    assert.equal(cancel.t, 'cancel');
    await ws.waitForType('leave');
    await ws.close();
  });
});

describe('SSE endpoint hardening', () => {
  const url = (): string => `http://127.0.0.1:${h.port}/api/rt`;

  it('refuses a POST for an unknown stream id', async () => {
    const res = await fetch(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sid: 'never-existed', msgs: [{ t: 'ping', ts: 1 }] }),
    });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: string }).error, 'no_stream');
  });

  it('rejects a malformed body', async () => {
    for (const body of ['not json', JSON.stringify({ nope: true }), JSON.stringify({ sid: 'x' }), JSON.stringify([])]) {
      const res = await fetch(url(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      assert.ok(res.status === 400, `expected 400 for ${body.slice(0, 20)}, got ${res.status}`);
      await res.arrayBuffer();
    }
  });

  it('rejects an oversized batch', async () => {
    const r = room();
    const c = new SseClient(h.port, newClientId('batch'));
    await c.open(r);
    const msgs = new Array(201).fill({ t: 'ping', ts: 1 });
    const res = await fetch(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sid: c.streamId, msgs }),
    });
    assert.equal(res.status, 413);
    await c.close();
  });

  it('ignores a hello smuggled into a POST batch', async () => {
    const r = room();
    const c = new SseClient(h.port, newClientId('smuggle'));
    await c.open(r);
    const res = await c.post(
      { t: 'hello', room: r, clientId: 'somebody-else-1', v: PROTOCOL_VERSION },
      { t: 'ping', ts: 5 },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, handled: 1 }, 'the hello was skipped, the ping handled');
    assert.equal((await c.waitForType('pong')).ts, 5);
    assert.deepEqual(c.ofType('error'), []);
    await c.close();
  });

  it('serves the health probe', async () => {
    const res = await fetch(`${url()}?mode=health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; transport: string; protocol: number };
    assert.equal(body.ok, true);
    assert.equal(body.transport, 'sse');
    assert.equal(body.protocol, PROTOCOL_VERSION);
  });

  it('answers a CORS preflight and rejects other verbs', async () => {
    const pre = await fetch(url(), { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    const bad = await fetch(url(), { method: 'DELETE' });
    assert.equal(bad.status, 405);
    assert.equal(bad.headers.get('allow'), 'GET, POST, OPTIONS');
    await bad.arrayBuffer();
  });

  it('sets the headers that keep proxies from buffering the stream', async () => {
    const controller = new AbortController();
    const res = await fetch(`${url()}?mode=stream&room=${room()}&cid=${newClientId('hdr')}`, {
      signal: controller.signal,
    });
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    assert.match(res.headers.get('cache-control') ?? '', /no-store/);
    controller.abort();
  });

  it('generates a stream id when the client does not supply one', async () => {
    const controller = new AbortController();
    const res = await fetch(`${url()}?mode=stream&room=${room()}&cid=${newClientId('anon')}`, {
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    // The preamble arrives as more than one chunk (`retry:` then the comment).
    while (!text.includes(': stream ')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(text, /: stream \S+/, 'the server announces the stream id it minted');
    controller.abort();
  });

  it('still applies the op limits reached through POST', async () => {
    const r = room();
    const c = new SseClient(h.port, newClientId('limits'));
    const w = await c.open(r);
    await c.post({
      t: 'begin',
      sid: `${w.you.id}-bad`,
      style: { color: 'not-a-colour', width: 2, tool: 'brush' },
      pts: [0, 0],
    });
    const err = await c.waitForType('error');
    assert.equal(err.code, 'bad_style');
    await c.close();
  });

  it('keeps working after a stroke drawn across separate POSTs', async () => {
    const r = room();
    const c = new SseClient(h.port, newClientId('multi'));
    const w = await c.open(r);
    const sid = `${w.you.id}-split`;
    await c.post({ t: 'begin', sid, style: { color: '#010203', width: 2, tool: 'brush' }, pts: [0, 0] });
    for (const chunk of [line(10, 0, 20, 10, 3), line(30, 20, 40, 30, 3)]) {
      await c.post({ t: 'points', sid, pts: chunk });
    }
    await c.post({ t: 'end', sid, n: 7 });
    const commit = await c.waitForType('commit');
    assert.ok(commit.op.pts.length >= 4, 'the stroke survived being split across requests');

    // And an ordinary stroke still commits afterwards.
    const next = await drawStroke(c, { points: line(200, 200, 260, 260, 5) });
    assert.equal(next.op.seq, 2);
    await c.close();
  });
});
