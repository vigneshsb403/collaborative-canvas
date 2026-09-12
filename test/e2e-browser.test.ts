/**
 * Browser end-to-end tests: real Chrome, real pointer input, real canvas pixels.
 *
 * These are the tests that prove the *drawing* works, not just the protocol: each
 * assertion samples the canvas backing store and counts painted pixels, so a
 * regression in the transform, the dirty-rect maths or the compositing order
 * fails here even when every message is correct.
 *
 * Uses `playwright-core`, which ships no browsers — it drives the Chrome already
 * installed on the machine. If no Chrome is found the whole suite skips rather
 * than failing, so `npm test` still works on a bare CI box.
 */

// Keep the server's join/leave logging out of the test output.
process.env.QUIET_LOGS = '1';

import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import type { Browser, ConsoleMessage, Page } from 'playwright-core';
import { startHarness, startVercelLikeHarness, type Harness } from './helpers.js';

/**
 * Closures passed to `page.evaluate` execute in the browser, but this file is
 * compiled with Node's lib. A minimal local declaration is enough to typecheck
 * them without pulling the whole DOM lib into the server build.
 */
declare const document: { getElementById(id: string): any };

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const WORLD_W = 1600;
const WORLD_H = 1000;

let browser: Browser | null = null;
let harness: Harness | null = null;
let skipReason: string | null = null;
const pageErrors: string[] = [];

before(async () => {
  if (!existsSync(join(PUBLIC_DIR, 'index.html'))) {
    skipReason = 'public/index.html missing — run `npm run build:client` first';
    return;
  }
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch (err) {
    skipReason = `no usable Chrome (${(err as Error).message.split('\n')[0]})`;
    return;
  }
  harness = await startHarness({ serveStatic: true });
});

after(async () => {
  await browser?.close();
  await harness?.close();
});

/* ------------------------------------------------------------------ */
/* Page helpers                                                        */
/* ------------------------------------------------------------------ */

interface Client {
  page: Page;
  /** Viewport coordinates for a point in world space. */
  at(wx: number, wy: number): Promise<{ x: number; y: number }>;
  ink(box: [number, number, number, number], canvas?: 'content' | 'overlay'): Promise<number>;
  eval<T>(fn: string): Promise<T>;
  userCount(): Promise<number>;
}

let roomSeq = 0;

async function open(transport?: 'sse'): Promise<{ room: string; a: Client; b: Client }> {
  const h = harness;
  const br = browser;
  if (h === null || br === null) throw new Error('harness not ready');
  const room = `e2e${++roomSeq}`;
  const query = transport === undefined ? '' : `&transport=${transport}`;
  const url = `http://127.0.0.1:${h.port}/?room=${room}${query}`;

  const make = async (): Promise<Client> => {
    // A fresh context per client: separate localStorage means separate identity.
    const context = await br.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (err: Error) => pageErrors.push(`${room}: ${err.message}`));
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') pageErrors.push(`${room} console: ${msg.text()}`);
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      "window.__canvas !== undefined && window.__canvas.state.selfId !== null",
      undefined,
      { timeout: 15_000 },
    );
    return wrap(page);
  };

  const a = await make();
  const b = await make();
  // Both must see each other before a test starts making claims about sync.
  for (const c of [a, b]) {
    await c.page.waitForFunction('window.__canvas.state.users.size === 2', undefined, { timeout: 10_000 });
  }
  return { room, a, b };
}

function wrap(page: Page): Client {
  const client: Client = {
    page,
    async at(wx, wy) {
      const rect = await page.evaluate(() => {
        const r = document.getElementById('overlay')!.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      });
      return {
        x: rect.left + (wx / WORLD_W) * rect.width,
        y: rect.top + (wy / WORLD_H) * rect.height,
      };
    },
    async ink(box, canvas = 'content') {
      return page.evaluate(
        ([id, x0, y0, x1, y1, worldW, worldH]) => {
          const el = document.getElementById(id as string);
          const ctx = el.getContext('2d')!;
          const kx = el.width / (worldW as number);
          const ky = el.height / (worldH as number);
          const px = Math.max(0, Math.floor((x0 as number) * kx));
          const py = Math.max(0, Math.floor((y0 as number) * ky));
          const pw = Math.min(el.width - px, Math.ceil(((x1 as number) - (x0 as number)) * kx) || 1);
          const ph = Math.min(el.height - py, Math.ceil(((y1 as number) - (y0 as number)) * ky) || 1);
          if (pw <= 0 || ph <= 0) return 0;
          const data = ctx.getImageData(px, py, pw, ph).data;
          let count = 0;
          for (let i = 3; i < data.length; i += 4) {
            if (data[i]! > 12) count++;
          }
          return count;
        },
        [canvas, box[0], box[1], box[2], box[3], WORLD_W, WORLD_H] as const,
      );
    },
    eval<T>(fn: string): Promise<T> {
      return page.evaluate(fn) as Promise<T>;
    },
    async userCount() {
      const text = await page.textContent('#user-count');
      return Number(text ?? '0');
    },
  };
  return client;
}

/**
 * Wait for a page-side condition. The expression is wrapped so that a predicate
 * which throws while the state is still arriving (`ops[0]` before any op exists)
 * is treated as "not yet" and retried, instead of failing the test outright.
 */
async function waitState(client: Client, expr: string, timeout = 10_000): Promise<void> {
  await client.page.waitForFunction(
    `(() => { try { return Boolean(${expr}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
}

/**
 * Wait until the renderer has nothing queued *and* two further frames have run,
 * so any repaint triggered by the message we just waited for has been composited
 * before we sample pixels.
 */
async function settled(client: Client): Promise<void> {
  await waitState(client, 'window.__canvas.renderer.hasWork === false', 8000);
  await client.page.evaluate(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))))',
  );
}

/** Drag the mouse through a list of world-space points. */
async function stroke(client: Client, points: [number, number][], opts: { release?: boolean } = {}): Promise<void> {
  const first = points[0]!;
  const start = await client.at(first[0], first[1]);
  await client.page.mouse.move(start.x, start.y);
  await client.page.mouse.down();
  for (const [wx, wy] of points.slice(1)) {
    const p = await client.at(wx, wy);
    await client.page.mouse.move(p.x, p.y, { steps: 4 });
  }
  if (opts.release !== false) await client.page.mouse.up();
}

async function closeBoth(a: Client, b: Client): Promise<void> {
  await a.page.context().close();
  await b.page.context().close();
}

function maybeSkip(t: { skip(reason: string): void }): boolean {
  if (skipReason !== null) {
    t.skip(skipReason);
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe('browser: two users on one canvas', () => {
  it('boots, connects over WebSocket and shows both participants', async (t) => {
    if (maybeSkip(t)) return;
    const { a, b } = await open();
    assert.equal(await a.eval<string>('window.__canvas.transport.kind'), 'ws');
    assert.equal(await a.eval<string>('window.__canvas.transport.status'), 'online');
    assert.equal(await a.userCount(), 2);
    assert.equal(await b.userCount(), 2);
    // Distinct presence colours, assigned by the server.
    const colorA = await a.eval<string>('window.__canvas.state.self.color');
    const colorB = await b.eval<string>('window.__canvas.state.self.color');
    assert.notEqual(colorA, colorB);
    await closeBoth(a, b);
  });

  it('paints a stroke locally and mirrors it to the other user', async (t) => {
    if (maybeSkip(t)) return;
    const { a, b } = await open();
    const box: [number, number, number, number] = [300, 300, 700, 500];
    assert.equal(await a.ink(box), 0, 'canvas starts empty');
    assert.equal(await b.ink(box), 0);

    await a.eval("window.__canvas.drawing.setColor('#ff0000'); window.__canvas.drawing.setWidth(10)");
    await stroke(a, [
      [320, 320],
      [450, 420],
      [600, 340],
      [680, 480],
    ]);

    await waitState(b, 'window.__canvas.state.log.size === 1');
    await settled(a);
    await settled(b);
    const inkA = await a.ink(box);
    const inkB = await b.ink(box);
    assert.ok(inkA > 500, `author should have painted pixels, got ${inkA}`);
    assert.ok(inkB > 500, `peer should have painted pixels, got ${inkB}`);
    // Both sides rasterise the same canonical op, so the coverage should be close.
    const ratio = Math.min(inkA, inkB) / Math.max(inkA, inkB);
    assert.ok(ratio > 0.9, `expected near-identical rasters, ratio ${ratio.toFixed(3)}`);

    // Nothing was painted outside the stroke's neighbourhood.
    assert.equal(await b.ink([0, 0, 200, 200]), 0, 'no stray ink elsewhere');
    await closeBoth(a, b);
  });

  it('shows a stroke on the peer while it is still being drawn', async (t) => {
    if (maybeSkip(t)) return;
    const { a, b } = await open();
    await a.eval('window.__canvas.drawing.setWidth(14)');
    // Hold the button down: nothing has been committed yet.
    await stroke(
      a,
      [
        [200, 600],
        [400, 650],
        [600, 620],
      ],
      { release: false },
    );

    await waitState(b, 'window.__canvas.state.live.size === 1');
    await b.page.waitForFunction(
      `(() => {
        const el = document.getElementById('content');
        const ctx = el.getContext('2d');
        const k = el.width / 1600;
        const d = ctx.getImageData(Math.floor(150 * k), Math.floor(560 * k), Math.ceil(520 * k), Math.ceil(140 * k)).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 12) n++;
        return n > 200;
      })()`,
      undefined,
      { timeout: 8000 },
    );
    assert.equal(await b.eval<number>('window.__canvas.state.log.size'), 0, 'still uncommitted');

    await a.page.mouse.up();
    await waitState(b, 'window.__canvas.state.log.size === 1');
    assert.equal(await b.eval<number>('window.__canvas.state.live.size'), 0, 'live stroke was promoted');
    await closeBoth(a, b);
  });

  it('renders the other user\'s cursor on the overlay', async (t) => {
    if (maybeSkip(t)) return;
    const { a, b } = await open();
    const p = await a.at(800, 500);
    await a.page.mouse.move(p.x, p.y);
    await a.page.mouse.move(p.x + 4, p.y + 4);

    await waitState(b, 'window.__canvas.state.cursors.size >= 1');
    await settled(b);
    const cursorInk = await b.ink([740, 440, 980, 560], 'overlay');
    assert.ok(cursorInk > 40, `expected a cursor marker on the overlay, got ${cursorInk} px`);
    // The content layer must be untouched by cursor drawing.
    assert.equal(await b.ink([740, 440, 980, 560], 'content'), 0);
    await closeBoth(a, b);
  });

  it('erases with the eraser, on both sides', async (t) => {
    if (maybeSkip(t)) return;
    const { a, b } = await open();
    await a.eval("window.__canvas.drawing.setColor('#0000ff'); window.__canvas.drawing.setWidth(26)");
    await stroke(a, [
      [400, 200],
      [900, 200],
    ]);
    await waitState(b, 'window.__canvas.state.log.size === 1');
    await settled(b);
    const before = await b.ink([380, 170, 920, 230]);
    assert.ok(before > 1000, `expected a thick line, got ${before}`);

    await a.eval("window.__canvas.drawing.setTool('eraser'); window.__canvas.drawing.setWidth(60)");
    await stroke(a, [
      [600, 130],
      [600, 270],
    ]);
    await waitState(b, 'window.__canvas.state.log.size === 2');
    await settled(b);

    const gap = await b.ink([575, 185, 625, 215]);
    assert.equal(gap, 0, 'the eraser should have cut a hole through the line');
    const remaining = await b.ink([380, 170, 920, 230]);
    assert.ok(remaining > 500 && remaining < before, `line partly erased: ${remaining} of ${before}`);
    await closeBoth(a, b);
  });
});

describe('browser: global undo', () => {
  it('lets one user undo another user\'s stroke, with both canvases agreeing', async (t) => {
    if (maybeSkip(t)) return;
    const { a, b } = await open();
    const box: [number, number, number, number] = [300, 300, 700, 500];
    await a.eval('window.__canvas.drawing.setWidth(12)');
    await stroke(a, [
      [340, 340],
      [500, 430],
      [660, 360],
    ]);
    await waitState(b, 'window.__canvas.state.log.size === 1');
    await settled(b);
    assert.ok((await b.ink(box)) > 400);

    // B undoes A's stroke with the keyboard, in the default "Everyone" scope.
    await b.page.keyboard.press('Control+z');
    await waitState(a, 'window.__canvas.state.log.ops[0].undone === true');
    await waitState(b, 'window.__canvas.state.log.ops[0].undone === true');
    await settled(a);
    await settled(b);
    assert.equal(await a.ink(box), 0, "the author's canvas cleared too");
    assert.equal(await b.ink(box), 0, 'and so did the peer that pressed undo');

    // And redo brings it back on both.
    await b.page.keyboard.press('Control+Shift+z');
    await waitState(a, 'window.__canvas.state.log.ops[0].undone === false');
    await settled(a);
    assert.ok((await a.ink(box)) > 400, 'redo repainted the stroke');
    await closeBoth(a, b);
  });

  it('scopes undo to my own strokes when asked', async (t) => {
    if (maybeSkip(t)) return;
    const { a, b } = await open();
    await a.eval('window.__canvas.drawing.setWidth(12)');
    await b.eval('window.__canvas.drawing.setWidth(12)');
    await stroke(a, [
      [200, 200],
      [400, 300],
    ]);
    await waitState(b, 'window.__canvas.state.log.size === 1');
    await stroke(b, [
      [900, 600],
      [1100, 700],
    ]);
    await waitState(a, 'window.__canvas.state.log.size === 2');

    // A switches to "Only me" and undoes: A's stroke must go, B's must stay.
    await a.page.click('#scope-mine');
    await a.page.click('#undo-btn');
    await waitState(b, 'window.__canvas.state.log.ops[0].undone === true');
    assert.equal(await b.eval<boolean>('window.__canvas.state.log.ops[1].undone'), false, "B's stroke survived");

    await settled(b);
    assert.equal(await b.ink([180, 180, 420, 320]), 0);
    assert.ok((await b.ink([880, 580, 1120, 720])) > 200);
    await closeBoth(a, b);
  });

  it('clears for everyone and restores on undo', async (t) => {
    if (maybeSkip(t)) return;
    const { a, b } = await open();
    await a.eval('window.__canvas.drawing.setWidth(16)');
    await stroke(a, [
      [500, 500],
      [800, 600],
    ]);
    await waitState(b, 'window.__canvas.state.log.size === 1');
    await settled(b);
    const box: [number, number, number, number] = [480, 480, 820, 620];
    assert.ok((await b.ink(box)) > 300);

    // Clear needs two clicks — the first arms it.
    await a.page.click('#clear-btn');
    await a.page.click('#clear-btn');
    await waitState(b, 'window.__canvas.state.log.activeClearSeq > 0');
    await settled(b);
    assert.equal(await b.ink(box), 0, 'cleared on the peer as well');

    await b.page.keyboard.press('Control+z');
    await waitState(a, 'window.__canvas.state.log.activeClearSeq === 0');
    await settled(a);
    assert.ok((await a.ink(box)) > 300, 'undoing the clear brought the drawing back');
    await closeBoth(a, b);
  });
});

describe('browser: the Vercel deployment shape', () => {
  it('discovers it cannot upgrade, falls back to SSE, and still collaborates', async (t) => {
    if (maybeSkip(t)) return;
    const br = browser;
    if (br === null) throw new Error('no browser');

    // Static files plus one function. No WebSocket endpoint exists at all, so
    // the client must work this out for itself — exactly as on Vercel.
    const vercel = await startVercelLikeHarness(PUBLIC_DIR);
    try {
      const room = `vercel${++roomSeq}`;
      const url = `http://127.0.0.1:${vercel.port}/?room=${room}`;
      const pages: Client[] = [];
      for (let i = 0; i < 2; i++) {
        const context = await br.newContext({ viewport: { width: 1280, height: 900 } });
        const page = await context.newPage();
        page.on('pageerror', (err: Error) => pageErrors.push(`${room}: ${err.message}`));
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction("window.__canvas !== undefined && window.__canvas.state.selfId !== null", undefined, {
          timeout: 20_000,
        });
        pages.push(wrap(page));
      }
      const [a, b] = pages as [Client, Client];
      for (const c of pages) await waitState(c, 'window.__canvas.state.users.size === 2', 15_000);

      assert.equal(await a.eval<string>('window.__canvas.transport.kind'), 'sse', 'fell back without being told to');
      assert.equal(await a.eval<string>('window.__canvas.transport.status'), 'online');

      await a.eval("window.__canvas.drawing.setColor('#aa00aa'); window.__canvas.drawing.setWidth(16)");
      await stroke(a, [
        [300, 300],
        [700, 550],
        [1100, 350],
      ]);
      await waitState(b, 'window.__canvas.state.log.size === 1', 15_000);
      await settled(b);
      assert.ok((await b.ink([280, 280, 1120, 570])) > 500, 'the stroke crossed a serverless-shaped deployment');

      // And global undo works over the same pair of plain HTTP calls.
      await b.page.keyboard.press('Control+z');
      await waitState(a, 'window.__canvas.state.log.ops[0].undone === true', 15_000);
      await settled(a);
      assert.equal(await a.ink([280, 280, 1120, 570]), 0);

      for (const c of pages) await c.page.context().close();
    } finally {
      await vercel.close();
    }
  });

  it('loads the app shell from a path-style room URL', async (t) => {
    if (maybeSkip(t)) return;
    const br = browser;
    if (br === null) throw new Error('no browser');
    const vercel = await startVercelLikeHarness(PUBLIC_DIR);
    try {
      const context = await br.newContext({ viewport: { width: 1000, height: 800 } });
      const page = await context.newPage();
      const failures: string[] = [];
      page.on('response', (res) => {
        if (res.status() >= 400) failures.push(`${res.status()} ${res.url()}`);
      });
      // Trailing slash: a relative asset reference would resolve to
      // /studio/assets/... and 404 here.
      await page.goto(`http://127.0.0.1:${vercel.port}/studio/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction("window.__canvas !== undefined && window.__canvas.state.selfId !== null", undefined, {
        timeout: 20_000,
      });
      assert.equal(await page.evaluate('window.__canvas.state.roomId'), 'studio');
      assert.deepEqual(failures, [], 'every asset resolved');
      await context.close();
    } finally {
      await vercel.close();
    }
  });
});

describe('browser: serverless transport', () => {
  it('collaborates over SSE + POST exactly as over WebSocket', async (t) => {
    if (maybeSkip(t)) return;
    const { a, b } = await open('sse');
    assert.equal(await a.eval<string>('window.__canvas.transport.kind'), 'sse');
    assert.equal(await a.eval<string>('window.__canvas.transport.status'), 'online');
    assert.equal(await a.userCount(), 2);

    await a.eval("window.__canvas.drawing.setColor('#00aa55'); window.__canvas.drawing.setWidth(14)");
    await stroke(a, [
      [250, 250],
      [600, 500],
      [950, 300],
    ]);
    await waitState(b, 'window.__canvas.state.log.size === 1', 15_000);
    await settled(b);
    assert.ok((await b.ink([230, 230, 970, 520])) > 500, 'stroke arrived over SSE');

    // Undo travels over the same transport.
    await b.page.click('#undo-btn');
    await waitState(a, 'window.__canvas.state.log.ops[0].undone === true', 15_000);
    await settled(a);
    assert.equal(await a.ink([230, 230, 970, 520]), 0, 'undo repainted over SSE too');
    await closeBoth(a, b);
  });
});

describe('browser: robustness', () => {
  it('recovers the drawing after a reload (delta resync)', async (t) => {
    if (maybeSkip(t)) return;
    const { a, b } = await open();
    await a.eval('window.__canvas.drawing.setWidth(14)');
    await stroke(a, [
      [300, 700],
      [700, 800],
    ]);
    await waitState(b, 'window.__canvas.state.log.size === 1');

    await b.page.reload({ waitUntil: 'domcontentloaded' });
    await waitState(b, 'window.__canvas && window.__canvas.state.log.size === 1', 15_000);
    await settled(b);
    assert.ok((await b.ink([280, 680, 720, 820])) > 300, 'the canvas came back after a reload');
    // Identity is stable across the reload, so presence still shows two people.
    assert.equal(await b.userCount(), 2);
    await closeBoth(a, b);
  });

  it('resumes a stroke that was interrupted by a reconnect, leaving no phantom', async (t) => {
    if (maybeSkip(t)) return;
    const { a, b } = await open();
    await a.eval('window.__canvas.drawing.setWidth(14)');

    // Drop the connection and begin a stroke while it is down, all in one
    // evaluation so the reconnect cannot land in the middle. The stroke's
    // `begin` is therefore sitting in the outbound queue under an id the server
    // has never seen, which is the exact condition that used to leave a phantom.
    const before = await a.page.evaluate(`(() => {
      const el = document.getElementById('overlay');
      const r = el.getBoundingClientRect();
      const at = (wx, wy) => ({ clientX: r.left + (wx / 1600) * r.width, clientY: r.top + (wy / 1000) * r.height });
      const ev = (type, wx, wy) => el.dispatchEvent(new PointerEvent(type, {
        pointerId: 99, isPrimary: true, button: type === 'pointermove' ? -1 : 0,
        buttons: 1, pointerType: 'mouse', bubbles: true, cancelable: true, ...at(wx, wy),
      }));
      window.__canvas.transport.dropConnection('test_drop');
      ev('pointerdown', 250, 300);
      ev('pointermove', 500, 420);
      ev('pointermove', 800, 300);
      window.__canvas.drawing.tick(1e9);   // force the point outbox into the queue
      return { status: window.__canvas.transport.status, queued: window.__canvas.transport.queue.length };
    })()`) as { status: string; queued: number };

    assert.equal(before.status, 'reconnecting', 'the stroke really did start while offline');
    assert.ok(before.queued > 0, 'and its messages really are queued');

    await waitState(a, "window.__canvas.transport.status === 'online'", 15_000);

    // Finish the stroke now that we are back.
    await a.page.evaluate(`(() => {
      const el = document.getElementById('overlay');
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 99, isPrimary: true, button: 0, buttons: 0, pointerType: 'mouse',
        bubbles: true, cancelable: true,
        clientX: r.left + (800 / 1600) * r.width, clientY: r.top + (300 / 1000) * r.height,
      }));
    })()`);

    await waitState(b, 'window.__canvas.state.log.size === 1', 15_000);
    await settled(b);

    // The decisive assertion: the abandoned id must not have opened a second,
    // never-ending live stroke on the peer.
    assert.equal(await b.eval<number>('window.__canvas.state.live.size'), 0, 'no phantom half-stroke left behind');
    assert.equal(await b.eval<number>('window.__canvas.state.log.size'), 1, 'exactly one committed stroke');
    assert.ok((await b.ink([230, 280, 820, 440])) > 300, 'the stroke drawn while offline arrived in full');
    await closeBoth(a, b);
  });

  it('survives a resize by re-rasterising at the new resolution', async (t) => {
    if (maybeSkip(t)) return;
    const { a, b } = await open();
    await a.eval('window.__canvas.drawing.setWidth(18)');
    await stroke(a, [
      [400, 400],
      [1200, 700],
    ]);
    await waitState(b, 'window.__canvas.state.log.size === 1');
    await settled(b);
    const before = await b.ink([380, 380, 1220, 720]);
    assert.ok(before > 1000, `expected a solid diagonal first, got ${before}`);

    await b.page.setViewportSize({ width: 820, height: 620 });
    await settled(b);
    const after = await b.ink([380, 380, 1220, 720]);
    assert.ok(after > 0, 'the stroke is still there after the resize');
    // Same world region, smaller raster: ink scales down but the shape persists.
    assert.ok(after < before, `expected fewer device pixels at a smaller size (${after} vs ${before})`);
    await closeBoth(a, b);
  });

  it('logs no page errors across the whole suite', async (t) => {
    if (maybeSkip(t)) return;
    assert.deepEqual(pageErrors, []);
  });
});
