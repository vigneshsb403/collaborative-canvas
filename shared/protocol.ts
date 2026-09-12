/**
 * Wire protocol shared by the WebSocket server, the serverless (SSE/POST)
 * transport and the browser client.
 *
 * Design notes
 * ------------
 * - Messages are JSON objects discriminated by a short `t` field. Field names
 *   are deliberately terse: a stroke in progress emits one `points` message
 *   every animation batch, so every byte is multiplied by (points/sec × users).
 * - Coordinates live in a fixed *world* space (WORLD_W × WORLD_H) so that every
 *   participant sees the same picture regardless of window size or DPR.
 * - Point lists are flat `[x0, y0, x1, y1, ...]` arrays rather than
 *   `{x, y}` objects: ~2.4x smaller on the wire and no per-point allocation
 *   when parsing.
 */

export const PROTOCOL_VERSION = 3;

/** Logical drawing surface. All wire coordinates are in this space. */
export const WORLD_W = 1600;
export const WORLD_H = 1000;

/** Coordinates are rounded to this many decimals before hashing/serialising. */
export const COORD_DECIMALS = 1;
const COORD_SCALE = 10 ** COORD_DECIMALS;

/** Snap a world coordinate to the wire grid. Keeps client and server byte-identical. */
export function quantize(v: number): number {
  return Math.round(v * COORD_SCALE) / COORD_SCALE;
}

export type Tool = 'brush' | 'eraser';

export interface StrokeStyle {
  /** CSS colour (`#rrggbb`). Ignored for the eraser, which composites out. */
  color: string;
  /** Stroke width in world units. */
  width: number;
  tool: Tool;
}

/** `[minX, minY, maxX, maxY]` in world space. */
export type BBox = [number, number, number, number];

export interface StrokeOp {
  kind: 'stroke';
  /** Globally unique, client-minted: `${userId}-${counter}`. */
  id: string;
  /** Server-assigned total order. Monotonic per room, starts at 1. */
  seq: number;
  userId: string;
  ts: number;
  style: StrokeStyle;
  /** Flat, simplified, quantised point list. */
  pts: number[];
  bbox: BBox;
  /** Visibility flag toggled by undo/redo. Ops are never removed from the log. */
  undone: boolean;
}

export interface ClearOp {
  kind: 'clear';
  id: string;
  seq: number;
  userId: string;
  ts: number;
  undone: boolean;
}

export type Op = StrokeOp | ClearOp;

export interface User {
  id: string;
  name: string;
  /** Presence colour assigned by the server; also the default brush colour. */
  color: string;
}

export interface Limits {
  maxPointsPerStroke: number;
  maxOpsPerRoom: number;
  maxStrokeWidth: number;
  minStrokeWidth: number;
}

export const LIMITS: Limits = {
  maxPointsPerStroke: 4000,
  maxOpsPerRoom: 5000,
  maxStrokeWidth: 120,
  minStrokeWidth: 1,
};

/** Undo scope. `global` walks the room-wide linear history; `mine` only my ops. */
export type UndoScope = 'global' | 'mine';

/** A stroke that is being drawn right now (not yet committed to the op log). */
export interface LiveStroke {
  sid: string;
  userId: string;
  style: StrokeStyle;
  pts: number[];
}

/* ------------------------------------------------------------------ */
/* Client -> Server                                                    */
/* ------------------------------------------------------------------ */

export interface CHello {
  t: 'hello';
  room: string;
  /** Stable per-browser id, so colour/name survive a reconnect. */
  clientId: string;
  name?: string;
  /** Last op `seq` the client already has; server replies with a delta. */
  since?: number;
  v: number;
}
export interface CBegin {
  t: 'begin';
  sid: string;
  style: StrokeStyle;
  pts: number[];
}
export interface CPoints {
  t: 'points';
  sid: string;
  pts: number[];
}
export interface CEnd {
  t: 'end';
  sid: string;
  /** Raw point count the client streamed; used to detect a lossy stream. */
  n: number;
}
export interface CCancel {
  t: 'cancel';
  sid: string;
}
export interface CCursor {
  t: 'cursor';
  x: number;
  y: number;
  active: boolean;
}
export interface CUndo {
  t: 'undo';
  scope: UndoScope;
}
export interface CRedo {
  t: 'redo';
  scope: UndoScope;
}
export interface CClear {
  t: 'clear';
}
export interface CRename {
  t: 'rename';
  name: string;
}
export interface CPing {
  t: 'ping';
  ts: number;
}
export interface CResync {
  t: 'resync';
  since?: number;
}

export type ClientMessage =
  | CHello
  | CBegin
  | CPoints
  | CEnd
  | CCancel
  | CCursor
  | CUndo
  | CRedo
  | CClear
  | CRename
  | CPing
  | CResync;

/* ------------------------------------------------------------------ */
/* Server -> Client                                                    */
/* ------------------------------------------------------------------ */

export interface SWelcome {
  t: 'welcome';
  v: number;
  room: string;
  you: User;
  users: User[];
  /** Full op log (or the delta after `since`, see `partial`). */
  ops: Op[];
  /** Strokes other users are drawing right now. */
  live: LiveStroke[];
  /** Highest assigned op seq. */
  seq: number;
  /** History version — bumps on every visibility change (undo/redo/clear). */
  hv: number;
  /**
   * Ids of every op that is currently undone. Only sent with a partial sync,
   * where ops *older* than `since` may have been undone while we were away and
   * are therefore not carried by the op list itself.
   */
  undone?: string[];
  partial: boolean;
  limits: Limits;
  serverTime: number;
}
export interface SSync {
  t: 'sync';
  ops: Op[];
  seq: number;
  hv: number;
  /** See `SWelcome.undone`. */
  undone?: string[];
  partial: boolean;
}
export interface SJoin {
  t: 'join';
  user: User;
}
export interface SLeave {
  t: 'leave';
  userId: string;
}
export interface SRename {
  t: 'rename';
  userId: string;
  name: string;
}
export interface SBegin {
  t: 'begin';
  sid: string;
  userId: string;
  style: StrokeStyle;
  pts: number[];
}
export interface SPoints {
  t: 'points';
  sid: string;
  userId: string;
  pts: number[];
}
export interface SCommit {
  t: 'commit';
  sid: string;
  op: StrokeOp;
  hv: number;
}
export interface SCancel {
  t: 'cancel';
  sid: string;
  userId: string;
}
export interface SCursor {
  t: 'cursor';
  userId: string;
  x: number;
  y: number;
  active: boolean;
}
export interface SVisibility {
  t: 'vis';
  /** Ops whose `undone` flag changed, with their new value. */
  changes: { id: string; undone: boolean }[];
  /** The op that was cleared/created by this action, if any (`clear`). */
  op?: ClearOp;
  by: string;
  action: 'undo' | 'redo' | 'clear';
  hv: number;
  seq: number;
}
export interface SPong {
  t: 'pong';
  ts: number;
  serverTime: number;
}
export interface SError {
  t: 'error';
  code: string;
  message: string;
  fatal?: boolean;
}
/** Serverless transport only: the SSE window is closing, reconnect now. */
export interface SReconnect {
  t: 'reconnect';
  reason: string;
}

export type ServerMessage =
  | SWelcome
  | SSync
  | SJoin
  | SLeave
  | SRename
  | SBegin
  | SPoints
  | SCommit
  | SCancel
  | SCursor
  | SVisibility
  | SPong
  | SError
  | SReconnect;

/* ------------------------------------------------------------------ */
/* Presence colours                                                    */
/* ------------------------------------------------------------------ */

/**
 * Hand-picked, evenly spaced hues that stay legible on both the light canvas
 * and the dark chrome. Index is assigned round-robin per room.
 */
export const USER_COLORS = [
  '#e8453c',
  '#f2a43a',
  '#f7d046',
  '#3fb950',
  '#2bb3a3',
  '#3b9ef5',
  '#7c6cf0',
  '#d861d8',
  '#ef6ea0',
  '#9a7b4f',
  '#57c2f0',
  '#8bc34a',
] as const;

const ANIMALS = [
  'Otter', 'Falcon', 'Heron', 'Lynx', 'Marlin', 'Bison', 'Gecko', 'Puffin',
  'Ocelot', 'Tapir', 'Wombat', 'Ibis', 'Kudu', 'Narwhal', 'Quokka', 'Serval',
] as const;

export function nameForIndex(i: number): string {
  const animal = ANIMALS[i % ANIMALS.length]!;
  const round = Math.floor(i / ANIMALS.length);
  return round === 0 ? animal : `${animal} ${round + 1}`;
}

export function colorForIndex(i: number): string {
  return USER_COLORS[i % USER_COLORS.length]!;
}
