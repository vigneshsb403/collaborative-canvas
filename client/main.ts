/**
 * Application entry point: owns the layout, the animation frame loop and the
 * wiring between transport -> state -> renderer/UI.
 *
 * The flow of a remote stroke, end to end:
 *
 *   Transport.onMessage -> ClientState.apply -> Effect[] -> applyEffects
 *     -> Renderer.markDirty / commitOp / repaintRegion
 *     -> next animation frame -> Renderer.present
 *
 * Nothing paints synchronously from a network message: messages only mark
 * regions dirty, and exactly one composite happens per animation frame no matter
 * how many users are drawing.
 */

import { Renderer } from './canvas.js';
import { clientId, currentRoom, storeName, storedName } from './config.js';
import { DrawingController } from './drawing.js';
import { ClientState, type Effect } from './state.js';
import { Ui } from './ui.js';
import { Transport } from './websocket.js';
import { WORLD_H, WORLD_W, type ServerMessage, type UndoScope } from '../shared/protocol.js';

const WORLD_RATIO = WORLD_W / WORLD_H;
/** Padding around the paper, matching `.stage` in style.css. */
const STAGE_PADDING = 14;
/** Ask for a resync if the tab was in the background at least this long. */
const RESYNC_AFTER_HIDDEN_MS = 10_000;
/** Second click on Clear must land within this window. */
const CLEAR_CONFIRM_MS = 3000;

const stage = required<HTMLElement>('stage');
const paper = required<HTMLElement>('paper');
const contentCanvas = required<HTMLCanvasElement>('content');
const overlayCanvas = required<HTMLCanvasElement>('overlay');

const state = new ClientState();
const renderer = new Renderer(contentCanvas, overlayCanvas);

let scope: UndoScope = 'global';
let historyDirty = true;
let lastHistoryAt = 0;
let livePresenceSignature = '';
let hintHidden = false;
let clearArmedAt = 0;
let hiddenSince = 0;

const ui = new Ui({
  setTool: (tool) => drawing.setTool(tool),
  setColor: (color) => drawing.setColor(color),
  setWidth: (width) => drawing.setWidth(width),
  setScope: (next) => {
    scope = next;
    ui.setScope(next);
    historyDirty = true;
  },
  undo: () => transport.sendNow({ t: 'undo', scope }),
  redo: () => transport.sendNow({ t: 'redo', scope }),
  clear: () => requestClear(),
  rename: (name) => {
    storeName(name);
    transport.sendNow({ t: 'rename', name });
  },
});

const transport = new Transport(currentRoom(), storedName(), {
  onMessage: (msg) => handleMessage(msg),
  onStatus: (status, detail) => {
    ui.setStatus(status, detail);
    if (status === 'reconnecting') ui.toast('Connection lost — retrying…', 'warn');
    if (status === 'offline') ui.toast('Disconnected.', 'error');
  },
  onReconnected: () => {
    ui.toast('Reconnected — canvas resynced.', 'info');
    // The server never saw the strokes we were drawing; re-issue them.
    drawing.restartActiveStrokes();
  },
  getSince: () => state.since,
});

const drawing = new DrawingController(overlayCanvas, state, {
  send: (msg) => transport.send(msg),
  sendNow: (msg) => transport.sendNow(msg),
  dirty: (box) => renderer.markDirty(box),
  overlayDirty: () => syncLocalBrush(),
  styleChanged: () => {
    ui.setStyle(drawing.style, window.devicePixelRatio || 1);
    syncLocalBrush();
  },
});

/* ------------------------------------------------------------------ */
/* Messages and effects                                                */
/* ------------------------------------------------------------------ */

function handleMessage(msg: ServerMessage): void {
  applyEffects(state.apply(msg));
}

function applyEffects(effects: Effect[]): void {
  for (const effect of effects) {
    switch (effect.kind) {
      case 'repaintAll':
        renderer.repaintAll(state);
        renderer.markLiveDirty(state.live.values());
        historyDirty = true;
        break;

      case 'commit':
        renderer.commitOp(effect.op);
        renderer.markDirty(effect.dirty);
        historyDirty = true;
        break;

      case 'region':
        renderer.repaintRegion(state, effect.bbox);
        historyDirty = true;
        break;

      case 'live':
        if (effect.dirty !== null) renderer.markDirty(effect.dirty);
        break;

      case 'presence':
        ui.setPresence(state);
        break;

      case 'cursors':
        renderer.markOverlayDirty();
        break;

      case 'identity':
        ui.setIdentity(state);
        adoptPresenceColour();
        break;

      case 'notice':
        handleNotice(effect.code, effect.message, effect.fatal);
        break;

      case 'gap':
        // We missed a history update: ask for the authoritative state.
        console.warn(`[canvas] history gap (expected hv ${effect.expected}, got ${effect.got}) — resyncing`);
        transport.sendNow({ t: 'resync', since: 0 });
        break;
    }
  }
  maybeHideHint();
}

function handleNotice(code: string, message: string, fatal: boolean): void {
  switch (code) {
    case 'version_mismatch':
      ui.toast('A new version was deployed — reloading…', 'warn');
      window.setTimeout(() => window.location.reload(), 1800);
      return;
    case 'superseded':
      ui.toast('This room was opened in another tab; that one is now the live session.', 'warn');
      drawing.cancelAll();
      return;
    case 'nothing_to_undo':
    case 'nothing_to_redo':
    case 'already_clear':
      ui.toast(message, 'info');
      historyDirty = true;
      return;
    case 'rate_limited':
      ui.toast('Drawing faster than the connection allows — some points were dropped.', 'warn');
      return;
    case 'room_full':
      ui.toast(message, 'error');
      return;
    default:
      ui.toast(message, fatal ? 'error' : 'warn');
  }
}

/** Start people off drawing in the colour they are identified by. */
let adoptedColour = false;
function adoptPresenceColour(): void {
  if (adoptedColour) return;
  const self = state.self;
  if (self === null) return;
  adoptedColour = true;
  drawing.setColor(self.color);
}

function requestClear(): void {
  const now = Date.now();
  if (now - clearArmedAt > CLEAR_CONFIRM_MS) {
    clearArmedAt = now;
    ui.toast('Click Clear again to wipe the canvas for everyone (undoable).', 'warn');
    return;
  }
  clearArmedAt = 0;
  transport.sendNow({ t: 'clear' });
}

function maybeHideHint(): void {
  if (hintHidden) return;
  if (state.log.visibleStrokes().length === 0 && state.live.size === 0) return;
  hintHidden = true;
  ui.hideHint();
}

function syncLocalBrush(): void {
  const cursor = drawing.localCursor;
  if (cursor === null) {
    renderer.setLocalBrush(null);
    return;
  }
  renderer.setLocalBrush({
    x: cursor.x,
    y: cursor.y,
    width: drawing.width,
    color: drawing.color,
    erasing: drawing.tool === 'eraser',
  });
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

/**
 * Size the paper to an exact aspect-fit of the world box. Done in JS rather than
 * with `aspect-ratio` so the result is an integer CSS size we can derive the
 * canvas backing store from — a fractional size would make strokes blurry.
 */
function fitPaper(): void {
  const availW = Math.max(64, stage.clientWidth - STAGE_PADDING * 2);
  const availH = Math.max(40, stage.clientHeight - STAGE_PADDING * 2);
  let width = availW;
  let height = width / WORLD_RATIO;
  if (height > availH) {
    height = availH;
    width = height * WORLD_RATIO;
  }
  width = Math.floor(width);
  height = Math.floor(width / WORLD_RATIO);

  paper.style.width = `${width}px`;
  paper.style.height = `${height}px`;

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const resized = renderer.resize(width, height, dpr);
  drawing.syncRect();
  if (resized) {
    // The raster resolution changed, so the committed layer is invalid.
    renderer.repaintAll(state);
    renderer.markLiveDirty(state.live.values());
    ui.setStyle(drawing.style, dpr);
  }
}

/* ------------------------------------------------------------------ */
/* Frame loop                                                          */
/* ------------------------------------------------------------------ */

function frame(now: number): void {
  drawing.tick(now);

  // Cursors fade out on idle, which needs a repaint while any is fading.
  for (const cursor of state.cursors.values()) {
    if (now - cursor.at < 4200) {
      renderer.markOverlayDirty();
      break;
    }
  }

  if (renderer.hasWork) renderer.present(state);

  // "Drawing now" dots depend on the live set; diff it once per frame instead of
  // rebuilding the presence list on every points message.
  const signature = liveSignature();
  if (signature !== livePresenceSignature) {
    livePresenceSignature = signature;
    ui.setPresence(state);
  }

  if (historyDirty && now - lastHistoryAt > 150) {
    historyDirty = false;
    lastHistoryAt = now;
    ui.setHistoryAvailability(state, scope);
  }

  ui.setStats(now, {
    transport: transport.kind,
    rtt: transport.rtt,
    ops: state.log.visibleStrokes().length,
    live: state.live.size,
    stats: renderer.stats,
  });

  requestAnimationFrame(frame);
}

function liveSignature(): string {
  if (state.live.size === 0) return '';
  const owners = new Set<string>();
  for (const stroke of state.live.values()) owners.add(stroke.userId);
  return [...owners].sort().join(',');
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

function onKeyDown(ev: KeyboardEvent): void {
  const target = ev.target as HTMLElement | null;
  if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
    return;
  }

  const mod = ev.metaKey || ev.ctrlKey;
  const key = ev.key.toLowerCase();

  if (mod && key === 'z') {
    ev.preventDefault();
    transport.sendNow(ev.shiftKey ? { t: 'redo', scope } : { t: 'undo', scope });
    return;
  }
  if (mod && key === 'y') {
    ev.preventDefault();
    transport.sendNow({ t: 'redo', scope });
    return;
  }
  if (mod) return;

  switch (key) {
    case 'b':
      drawing.setTool('brush');
      break;
    case 'e':
      drawing.setTool('eraser');
      break;
    case '[':
      drawing.setWidth(drawing.width - step(drawing.width));
      break;
    case ']':
      drawing.setWidth(drawing.width + step(drawing.width));
      break;
    case 'escape':
      if (drawing.isDrawing) {
        drawing.cancelAll();
        ui.toast('Stroke discarded.', 'info');
      }
      break;
    default:
      return;
  }
  ev.preventDefault();
}

/** Larger jumps for larger brushes, so [ and ] feel linear in perceived size. */
function step(width: number): number {
  return Math.max(1, Math.round(width * 0.2));
}

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

function required<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el as T;
}

ui.setScope(scope);
ui.setStyle(drawing.style, window.devicePixelRatio || 1);
ui.setRoom(currentRoom());
fitPaper();

new ResizeObserver(() => fitPaper()).observe(stage);
window.addEventListener('resize', fitPaper);
window.addEventListener('keydown', onKeyDown);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenSince = Date.now();
    return;
  }
  // A backgrounded tab may have been suspended mid-stream; make sure we agree
  // with the server before drawing on top of a stale picture.
  if (hiddenSince > 0 && Date.now() - hiddenSince > RESYNC_AFTER_HIDDEN_MS && transport.status === 'online') {
    transport.sendNow({ t: 'resync', since: 0 });
  }
  hiddenSince = 0;
  fitPaper();
});

transport.start();
requestAnimationFrame(frame);

// Handy for debugging from the console; not part of any API.
Object.assign(window as unknown as Record<string, unknown>, {
  __canvas: { state, renderer, transport, drawing, clientId },
});
