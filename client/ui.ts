/**
 * DOM chrome: toolbar, presence list, status, stats, toasts.
 *
 * The markup lives in `index.html`; this module only binds behaviour and pushes
 * state into it. Keeping it separate from `canvas.ts` means the render loop never
 * touches the DOM, and DOM updates never happen per animation frame — the stats
 * readout is the one exception and it is throttled to 4Hz.
 */

import { readableOn, type RenderStats } from './canvas.js';
import type { StrokeStyle, Tool, UndoScope } from '../shared/protocol.js';
import type { ClientState } from './state.js';
import type { TransportStatus } from './websocket.js';

/** Drawing palette. The user's own presence colour is prepended at runtime. */
const PALETTE = [
  '#1f2430',
  '#e8453c',
  '#f2a43a',
  '#f7d046',
  '#3fb950',
  '#2bb3a3',
  '#3b9ef5',
  '#7c6cf0',
  '#d861d8',
  '#6b7383',
];

const TOAST_TTL_MS = 3600;
const TOAST_DEDUPE_MS = 1500;

export type ToastKind = 'info' | 'warn' | 'error';

export interface UiHooks {
  setTool(tool: Tool): void;
  setColor(color: string): void;
  setWidth(width: number): void;
  setScope(scope: UndoScope): void;
  undo(): void;
  redo(): void;
  clear(): void;
  rename(name: string): void;
}

export class Ui {
  private readonly el: {
    roomChip: HTMLButtonElement;
    roomName: HTMLElement;
    statusChip: HTMLElement;
    statusText: HTMLElement;
    statusDetail: HTMLElement;
    nameInput: HTMLInputElement;
    nameDot: HTMLElement;
    swatches: HTMLElement;
    colorInput: HTMLInputElement;
    widthInput: HTMLInputElement;
    widthValue: HTMLElement;
    widthPreview: HTMLCanvasElement;
    toolBrush: HTMLButtonElement;
    toolEraser: HTMLButtonElement;
    scopeGlobal: HTMLButtonElement;
    scopeMine: HTMLButtonElement;
    undoBtn: HTMLButtonElement;
    redoBtn: HTMLButtonElement;
    clearBtn: HTMLButtonElement;
    userList: HTMLElement;
    userCount: HTMLElement;
    toasts: HTMLElement;
    hint: HTMLElement;
    stat: Record<string, HTMLElement>;
  };

  private lastToast = { message: '', at: 0 };
  private lastStatsAt = 0;
  private paletteColors: string[] = PALETTE;
  private renameTimer: number | null = null;

  constructor(private readonly hooks: UiHooks) {
    this.el = {
      roomChip: byId('room-chip'),
      roomName: byId('room-name'),
      statusChip: byId('status-chip'),
      statusText: byId('status-text'),
      statusDetail: byId('status-detail'),
      nameInput: byId('name-input'),
      nameDot: byId('name-dot'),
      swatches: byId('swatches'),
      colorInput: byId('color-input'),
      widthInput: byId('width-input'),
      widthValue: byId('width-value'),
      widthPreview: byId('width-preview'),
      toolBrush: byId('tool-brush'),
      toolEraser: byId('tool-eraser'),
      scopeGlobal: byId('scope-global'),
      scopeMine: byId('scope-mine'),
      undoBtn: byId('undo-btn'),
      redoBtn: byId('redo-btn'),
      clearBtn: byId('clear-btn'),
      userList: byId('user-list'),
      userCount: byId('user-count'),
      toasts: byId('toasts'),
      hint: byId('paper-hint'),
      stat: {
        transport: byId('stat-transport'),
        rtt: byId('stat-rtt'),
        ops: byId('stat-ops'),
        live: byId('stat-live'),
        fps: byId('stat-fps'),
        dirty: byId('stat-dirty'),
      },
    };
    this.bind();
    this.buildSwatches(null);
  }

  private bind(): void {
    this.el.toolBrush.addEventListener('click', () => this.hooks.setTool('brush'));
    this.el.toolEraser.addEventListener('click', () => this.hooks.setTool('eraser'));
    this.el.scopeGlobal.addEventListener('click', () => this.hooks.setScope('global'));
    this.el.scopeMine.addEventListener('click', () => this.hooks.setScope('mine'));
    this.el.undoBtn.addEventListener('click', () => this.hooks.undo());
    this.el.redoBtn.addEventListener('click', () => this.hooks.redo());
    this.el.clearBtn.addEventListener('click', () => this.hooks.clear());

    this.el.widthInput.addEventListener('input', () => {
      this.hooks.setWidth(Number(this.el.widthInput.value));
    });
    this.el.colorInput.addEventListener('input', () => {
      this.hooks.setColor(this.el.colorInput.value.toLowerCase());
    });

    this.el.nameInput.addEventListener('input', () => {
      // Debounced: typing a name should not emit a message per keystroke.
      if (this.renameTimer !== null) window.clearTimeout(this.renameTimer);
      this.renameTimer = window.setTimeout(() => {
        this.renameTimer = null;
        const value = this.el.nameInput.value.trim();
        if (value.length > 0) this.hooks.rename(value);
      }, 400);
    });

    this.el.roomChip.addEventListener('click', () => void this.copyInvite());
  }

  /* ---------------------------------------------------------------- */

  private buildSwatches(selfColor: string | null): void {
    const colors = selfColor === null ? PALETTE : [selfColor, ...PALETTE.filter((c) => c !== selfColor)].slice(0, 10);
    this.paletteColors = colors;
    this.el.swatches.replaceChildren(
      ...colors.map((color) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'swatch';
        if (selfColor !== null && color === selfColor) {
          btn.classList.add('is-mine');
          btn.title = `${color} — your presence colour`;
        } else {
          btn.title = color;
        }
        btn.style.background = color;
        btn.dataset.color = color;
        btn.addEventListener('click', () => this.hooks.setColor(color));
        return btn;
      }),
    );
  }

  /** Reflect the current brush settings back into the controls. */
  setStyle(style: StrokeStyle, dpr: number): void {
    this.el.toolBrush.classList.toggle('is-active', style.tool === 'brush');
    this.el.toolEraser.classList.toggle('is-active', style.tool === 'eraser');
    this.el.widthInput.value = String(style.width);
    this.el.widthValue.textContent = `${style.width}px`;
    this.el.colorInput.value = style.color;

    for (const node of this.el.swatches.children) {
      const swatch = node as HTMLElement;
      const active = style.tool === 'brush' && swatch.dataset.color === style.color;
      swatch.classList.toggle('is-active', active);
    }
    drawWidthPreview(this.el.widthPreview, style, dpr);
  }

  setScope(scope: UndoScope): void {
    this.el.scopeGlobal.classList.toggle('is-active', scope === 'global');
    this.el.scopeMine.classList.toggle('is-active', scope === 'mine');
  }

  setStatus(status: TransportStatus, detail: string): void {
    this.el.statusChip.dataset.state = status;
    this.el.statusText.textContent = status;
    this.el.statusDetail.textContent = detail;
  }

  setRoom(room: string): void {
    this.el.roomName.textContent = room;
  }

  setIdentity(state: ClientState): void {
    const self = state.self;
    if (self === null) return;
    this.el.nameDot.style.background = self.color;
    if (document.activeElement !== this.el.nameInput) {
      this.el.nameInput.value = self.name;
    }
    if (this.paletteColors[0] !== self.color) this.buildSwatches(self.color);
    this.setRoom(state.roomId);
  }

  /** Rebuild the presence list. Called on join/leave/rename only. */
  setPresence(state: ClientState): void {
    const selfId = state.selfId;
    const drawing = new Set<string>();
    for (const stroke of state.live.values()) drawing.add(stroke.userId);

    const users = [...state.users.values()].sort((a, b) => {
      if (a.id === selfId) return -1;
      if (b.id === selfId) return 1;
      return a.name.localeCompare(b.name);
    });

    this.el.userCount.textContent = String(users.length);
    this.el.userList.replaceChildren(
      ...users.map((user) => {
        const li = document.createElement('li');
        li.className = 'user';
        if (user.id === selfId) li.classList.add('is-self');

        const dot = document.createElement('span');
        dot.className = 'user-dot';
        dot.style.background = user.color;

        const name = document.createElement('span');
        name.className = 'user-name';
        name.textContent = user.name;

        li.append(dot, name);

        if (user.id === selfId) {
          const tag = document.createElement('span');
          tag.className = 'user-tag';
          tag.textContent = 'you';
          li.append(tag);
        } else if (drawing.has(user.id)) {
          const pulse = document.createElement('span');
          pulse.className = 'user-drawing';
          pulse.title = 'drawing now';
          li.append(pulse);
        }
        return li;
      }),
    );
  }

  /**
   * Enable/disable the history buttons from what we can see locally. The server
   * is the authority — it will answer with a notice if a request is impossible —
   * but disabling an obviously dead button is better than an error toast.
   */
  setHistoryAvailability(state: ClientState, scope: UndoScope): void {
    const selfId = state.selfId;
    let canUndo = false;
    let canRedo = false;
    for (const op of state.log.ops) {
      const mine = op.userId === selfId;
      if (scope === 'mine' && !mine) continue;
      if (op.undone) canRedo = true;
      else if (op.kind === 'clear' || state.log.isVisible(op)) canUndo = true;
    }
    this.el.undoBtn.disabled = !canUndo;
    this.el.redoBtn.disabled = !canRedo;
    this.el.clearBtn.disabled = state.log.visibleStrokes().length === 0;
  }

  /** Stats are cosmetic; 4Hz is plenty and keeps layout work off the hot path. */
  setStats(
    now: number,
    info: { transport: string; rtt: number; ops: number; live: number; stats: RenderStats },
  ): void {
    if (now - this.lastStatsAt < 250) return;
    this.lastStatsAt = now;
    this.el.stat.transport!.textContent = info.transport;
    this.el.stat.rtt!.textContent = info.rtt < 0 ? '—' : `${info.rtt} ms`;
    this.el.stat.ops!.textContent = String(info.ops);
    this.el.stat.live!.textContent = String(info.live);
    this.el.stat.fps!.textContent = info.stats.fps === 0 ? '—' : String(info.stats.fps);
    this.el.stat.dirty!.textContent =
      info.stats.dirtyRatio === 0 ? '—' : `${Math.min(100, Math.round(info.stats.dirtyRatio * 100))}%`;
  }

  hideHint(): void {
    this.el.hint.classList.add('is-hidden');
  }

  toast(message: string, kind: ToastKind = 'info'): void {
    const now = Date.now();
    if (message === this.lastToast.message && now - this.lastToast.at < TOAST_DEDUPE_MS) return;
    this.lastToast = { message, at: now };

    const node = document.createElement('div');
    node.className = 'toast';
    node.dataset.kind = kind;
    node.textContent = message;
    this.el.toasts.append(node);

    window.setTimeout(() => {
      node.classList.add('is-leaving');
      window.setTimeout(() => node.remove(), 300);
    }, TOAST_TTL_MS);

    // Never let a flood of notices pile up on screen.
    while (this.el.toasts.children.length > 3) this.el.toasts.firstElementChild?.remove();
  }

  private async copyInvite(): Promise<void> {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      this.el.roomChip.classList.add('is-copied');
      this.toast('Invite link copied — open it in another window or device.', 'info');
      window.setTimeout(() => this.el.roomChip.classList.remove('is-copied'), 1200);
    } catch {
      this.toast('Copy failed — the link is in the address bar.', 'warn');
    }
  }
}

function drawWidthPreview(canvas: HTMLCanvasElement, style: StrokeStyle, dpr: number): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  const size = 30;
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  // The preview is shown at a matching visual scale, capped to the box.
  const r = Math.max(1, Math.min(size / 2 - 3, style.width / 2));
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, r, 0, Math.PI * 2);
  if (style.tool === 'eraser') {
    ctx.fillStyle = '#e6e8ee';
    ctx.fill();
    ctx.strokeStyle = '#0b0d12';
    ctx.lineWidth = 1;
    ctx.stroke();
  } else {
    ctx.fillStyle = style.color;
    ctx.fill();
    // Keep a dark swatch visible against the dark panel.
    ctx.strokeStyle = readableOn(style.color) === '#ffffff' ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing element #${id}`);
  return el as T;
}
