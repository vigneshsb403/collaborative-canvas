/**
 * Runtime configuration: where to connect, which room, who we are.
 *
 * `public/config.js` is generated at build time and may set
 * `window.CANVAS_CONFIG.wsUrl` from the PUBLIC_WS_URL env var. That is the
 * escape hatch for a static deploy (Vercel) that wants to talk to a real
 * WebSocket server hosted elsewhere.
 */

export type TransportKind = 'ws' | 'sse';

export interface RuntimeConfig {
  /** Absolute ws:// or wss:// URL, or null to derive it from location. */
  wsUrl: string | null;
  build: string;
}

declare global {
  interface Window {
    CANVAS_CONFIG?: Partial<RuntimeConfig>;
  }
}

const injected = window.CANVAS_CONFIG ?? {};

export const CONFIG: RuntimeConfig = {
  wsUrl: typeof injected.wsUrl === 'string' && injected.wsUrl.length > 0 ? injected.wsUrl : null,
  build: typeof injected.build === 'string' ? injected.build : 'dev',
};

const params = new URLSearchParams(window.location.search);

/** Room slug from `?room=`, or the first path segment, defaulting to `main`. */
export function currentRoom(): string {
  const fromQuery = params.get('room');
  const fromPath = window.location.pathname.replace(/^\/+|\/+$/g, '');
  const raw = fromQuery ?? (fromPath.length > 0 ? fromPath : 'main');
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return cleaned.length === 0 ? 'main' : cleaned.slice(0, 40);
}

/** `?transport=ws|sse` forces a transport; otherwise we probe. */
export function forcedTransport(): TransportKind | null {
  const t = params.get('transport');
  return t === 'ws' || t === 'sse' ? t : null;
}

export function websocketUrl(): string {
  if (CONFIG.wsUrl !== null) return CONFIG.wsUrl;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

export function realtimeHttpUrl(): string {
  return new URL('/api/rt', window.location.origin).toString();
}

const CLIENT_ID_KEY = 'canvas.clientId';
const NAME_KEY = 'canvas.name';
const TRANSPORT_MEMO_KEY = 'canvas.transport';

/**
 * A stable per-browser id. The server uses it to hand back the same colour,
 * name and personal undo stack after a reload, so it must outlive the tab.
 * Falls back to an in-memory id when storage is blocked (private mode).
 */
export const clientId: string = (() => {
  const generated = `c${randomToken(16)}`;
  try {
    const existing = window.localStorage.getItem(CLIENT_ID_KEY);
    if (existing !== null && /^[A-Za-z0-9_-]{6,48}$/.test(existing)) return existing;
    window.localStorage.setItem(CLIENT_ID_KEY, generated);
  } catch {
    /* storage unavailable — a per-session identity still works */
  }
  return generated;
})();

/** A per-page-load nonce, so stroke ids never collide across reloads. */
export const sessionNonce: string = randomToken(6);

export function storedName(): string | null {
  try {
    return window.localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

export function storeName(name: string): void {
  try {
    window.localStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
}

/** Remember which transport worked, to skip the probe on the next load. */
export function memoTransport(kind: TransportKind): void {
  try {
    window.sessionStorage.setItem(TRANSPORT_MEMO_KEY, kind);
  } catch {
    /* ignore */
  }
}

export function memoedTransport(): TransportKind | null {
  try {
    const v = window.sessionStorage.getItem(TRANSPORT_MEMO_KEY);
    return v === 'ws' || v === 'sse' ? v : null;
  } catch {
    return null;
  }
}

function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += (b % 36).toString(36);
  return out;
}
