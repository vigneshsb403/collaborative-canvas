# Architecture

A multi-user drawing canvas in vanilla TypeScript: no frontend framework, no
drawing library, no CRDT library. Two deployment shapes share one implementation
— a long-lived Node + WebSocket server, and a Vercel deployment where the same
protocol runs over Server-Sent Events with batched POSTs.

---

## 1. Module map

```
shared/                 runs on BOTH sides — this is the point
  protocol.ts           wire types, world size, presence palette
  geometry.ts           RDP simplification, stroke bounds, input sanitisers
  oplog.ts              the op log + the visibility rule

server/
  drawing-state.ts      authoritative state per room: total order + undo stacks
  rooms.ts              presence, identity parking, colour assignment, rate limit
  hub.ts                protocol dispatch (transport-agnostic)
  server.ts             Express + ws          (primary deployment)
  serverless.ts         SSE + POST transport  (Vercel deployment)

api/
  rt.ts                 the Vercel function — thin wrapper over serverless.ts

client/
  main.ts               layout, frame loop, wiring
  canvas.ts             rendering: three surfaces, dirty rectangles
  drawing.ts            pointer capture, thinning, batching, prediction
  websocket.ts          transport: WebSocket, or SSE+POST fallback
  state.ts              state mirror -> minimal render effects (DOM-free)
  ui.ts                 toolbar, presence, stats, toasts
```

Two decisions shape everything else:

**The op log is shared code.** `shared/oplog.ts` runs unchanged on the server and
in the browser. "Is this stroke visible?" is answered by the same function on both
ends, so a client cannot drift from the server's idea of the picture after an undo
it did not initiate.

**The hub is transport-agnostic.** `server/hub.ts` talks to a `Connection`
interface (`send`, `close`, `id`, `kind`). The WebSocket server and the serverless
SSE transport each implement it in about 40 lines. There is exactly one copy of
the protocol logic, and the integration tests put a WebSocket client and an SSE
client in the same room to prove it.

---

## 2. Data flow

### The life of one stroke

```
  ┌─────────────────────────────── one user's browser ──────────────────────────────┐
  │                                                                                 │
  │  pointerdown / pointermove / pointerup                                          │
  │            │                                                                    │
  │            │ getCoalescedEvents()  ← recovers samples the browser merged         │
  │            ▼                                                                    │
  │  ┌──────────────────┐   thin (< 0.75 world units apart are dropped)              │
  │  │ DrawingController│──────────────┬─────────────────────────────┐               │
  │  └──────────────────┘              │                             │               │
  │            │ state.addOwnLive()    │ accumulate outbox           │ markDirty(box)│
  │            ▼                       ▼                             ▼               │
  │  ┌──────────────────┐   ┌────────────────────┐      ┌────────────────────────┐   │
  │  │   ClientState    │   │  Transport (33ms)  │      │  Renderer (per frame)  │   │
  │  │ live: Map<sid,…> │   │  coalesce -> 1 msg │      │  blit dirty rect, then │   │
  │  └──────────────────┘   └────────────────────┘      │  draw live strokes     │   │
  │                                   │                 └────────────────────────┘   │
  └───────────────────────────────────│─────────────────────────────────────────────┘
                                      │  begin / points / end
                                      ▼
  ┌──────────────────────────────── server ─────────────────────────────────────────┐
  │  Hub.handleRaw ─ parse, rate-limit ─► DrawingState                              │
  │                                         ├─ sanitize style + points              │
  │                                         ├─ accumulate pending stroke            │
  │                                         └─ on `end`: simplify, assign seq,      │
  │                                            append to the op log  ← TOTAL ORDER  │
  │                                                     │                           │
  │      broadcast begin/points to everyone *except* the author (they drew it)       │
  │      broadcast commit to everyone *including* the author (canonical op)          │
  └─────────────────────────────────────│───────────────────────────────────────────┘
                                        ▼
  ┌───────────────────────── every other browser ───────────────────────────────────┐
  │  Transport.onMessage ─► ClientState.apply ─► Effect[] ─► Renderer               │
  │      begin/points  ──► live stroke updated, dirty = new segment + join           │
  │      commit        ──► op appended, rasterised once onto the committed layer     │
  │      vis           ──► visibility flipped, dirty = that op's bounds              │
  │                                                                                 │
  │  Nothing paints synchronously from a message. One composite per frame.           │
  └─────────────────────────────────────────────────────────────────────────────────┘
```

### Why the author does not get its own `begin`/`points` back

The author already drew them (client-side prediction). Echoing them would be pure
waste at exactly the moment the connection is busiest. The author *does* receive
the `commit`, because that carries the canonical, simplified point list and the
authoritative `seq` — see §5.

### Coordinate model

Every coordinate on the wire is in a fixed **world** space of 1600×1000, rounded
to one decimal. The alternative — sending screen pixels — means two users with
different window sizes see different drawings. The canvas element is aspect-fitted
to that ratio and a single canvas transform (`setTransform(k,0,0,k,0,0)`) converts
world units to device pixels, so no drawing code does its own scaling arithmetic.

The one exception is the cursor overlay, which draws in CSS pixels so that name
labels keep a constant size regardless of window size.

---

## 3. Wire protocol

JSON, discriminated by a short `t` field. Field names are terse because a stroke
in progress emits ~30 messages per second per drawing user, multiplied by every
participant. Point lists are flat `[x0,y0,x1,y1,…]` arrays: about 2.4× smaller
than `{x,y}` objects and no per-point allocation on parse.

Either side may send a **JSON array** of messages in place of a single object. The
client coalesces everything produced in one animation frame; the server coalesces
everything produced in one tick. During a busy multi-user session a tick commonly
carries several `points` plus a `cursor` — one frame instead of four.

### Client → server

| `t` | payload | notes |
|---|---|---|
| `hello` | `room, clientId, v, name?, since?` | must be first. `since` requests a delta |
| `begin` | `sid, style, pts` | starts a stroke. `sid` must be prefixed `${userId}-` |
| `points` | `sid, pts` | appends; server echoes only the points it kept |
| `end` | `sid, n` | `n` = raw point count, for desync detection |
| `cancel` | `sid` | abandons a stroke (Escape, pointercancel) |
| `cursor` | `x, y, active` | throttled client-side to 20Hz, server-side to ~45Hz |
| `undo` / `redo` | `scope: 'global' \| 'mine'` | see §6 |
| `clear` | — | an ordinary, undoable op |
| `rename` | `name` | sanitised, ≤24 chars |
| `ping` | `ts` | RTT + liveness |
| `resync` | `since?` | "I think I missed something" |

### Server → client

| `t` | payload | notes |
|---|---|---|
| `welcome` | `you, users, ops, live, seq, hv, partial, undone?, limits, serverTime` | the join response |
| `sync` | `ops, seq, hv, partial, undone?` | answer to `resync` |
| `join` / `leave` / `rename` | user info | presence |
| `begin` / `points` / `cancel` | `sid, userId, …` | live strokes from others |
| `commit` | `sid, op, hv` | the canonical op, with its `seq` |
| `vis` | `changes[], op?, by, action, hv, seq` | visibility changed (undo/redo/clear) |
| `cursor` | `userId, x, y, active` | |
| `pong` | `ts, serverTime` | |
| `error` | `code, message, fatal?` | non-fatal by default (e.g. "nothing to undo") |
| `reconnect` | `reason` | serverless only: this window is closing, reopen |

### `hv` — the history version

Every server action that changes history (`commit`, `undo`, `redo`, `clear`) bumps
`hv` by exactly one and broadcasts it. A client that receives `hv` greater than
`lastHv + 1` has provably missed a message and immediately requests a resync. This
is 12 lines of code that turns "silent divergence" — the worst failure mode in a
collaborative editor — into a self-healing event.

---

## 4. The op log and the visibility rule

An op is a stroke or a clear. **Ops are never deleted and never mutated except for
one boolean.** The picture is *derived*:

```ts
visible(stroke) = !stroke.undone && stroke.seq > activeClearSeq
```

where `activeClearSeq` is the `seq` of the highest non-undone `clear` op.

This is the load-bearing design decision. Because visibility is a pure function of
the log, two clients that have received the same set of messages *cannot* disagree
about the picture, **regardless of the order the messages arrived in**. Undo is not
an inverse operation that has to be applied in the right order; it is a flag. The
test suite asserts this directly by building the same log in several different
arrival orders and comparing the resulting visible set.

A clear is modelled as an op that masks everything before it, rather than as a
deletion. Undoing a clear is therefore automatic: flip its flag and
`activeClearSeq` falls back to the previous active clear (or 0), and every stroke
reappears — including the knowledge of which strokes were *separately* undone
before the clear happened.

---

## 5. Canonicalisation, and why it is deterministic

Raw pointer input is far denser than the drawing needs. Strokes are simplified
with Ramer–Douglas–Peucker at a 0.45 world-unit tolerance, which removes 50–80% of
the points on a real hand-drawn stroke with no visible change once the path is
rendered with quadratic smoothing.

Simplification runs **on the server** at `end`, and the result is what everyone
stores. The client also simplifies nothing locally — it keeps its raw prediction on
the live layer until the `commit` arrives, then adopts the canonical op and
repaints the union of both bounding boxes. That reconciliation is exact and costs
one small region repaint.

`shared/geometry.ts` uses only `+ - * /` and comparisons on IEEE-754 doubles, so
it is bit-for-bit deterministic across engines. That is what makes the `end`
message able to carry just a point *count* (`n`) rather than the whole path: the
server compares its own accumulated count and logs a desync if they differ. Both
sides also apply the identical capture-time thinning rule (`appendPoints`), so the
accumulated raw paths match in the first place.

---

## 6. Undo/redo strategy

This is the hard part of the assignment, so here is the full reasoning.

### The shape of the problem

Linear undo works in a single-user editor because "the last thing that happened"
is unambiguous. With several people drawing at once there are two reasonable and
*incompatible* answers to "what should Ctrl+Z do?":

1. **Room-wide (linear):** undo the last thing *anybody* did. Matches a shared
   whiteboard, and is what makes "undo that, it was a mistake" work as a
   collaborative act. But it lets someone undo your work.
2. **Per-user:** undo the last thing *I* did. Never surprises anyone, but it
   cannot express "somebody please take that back", and two users undoing
   concurrently can produce a state neither of them intended.

Real tools pick one and live with it. This implementation **offers both** and lets
the user switch with a toggle in the toolbar (`Everyone` / `Only me`), because
which one is correct genuinely depends on what the room is for.

### Implementation

The server keeps two stacks per scope: a room-wide pair, and a pair per user.

- A new op pushes its id onto the global undo stack and its author's undo stack.
- It clears the global redo stack and *its author's* redo stack — a new edit
  truncates the branch you were on. It deliberately leaves **other** users' redo
  stacks alone: their "redo mine" still refers to their own work, and nobody
  expects your stroke to destroy their ability to restore theirs.
- `undo` pops from the requested scope's stack, flips the op's flag, and pushes it
  onto **both** the global redo stack and the owner's redo stack. `redo` is the
  mirror image.

### Lazy validation — this is the conflict resolution

Stack entries are hints, not commitments. On pop, an entry is only actionable if
the op's *current* state still matches what the stack implies:

```ts
// undo candidate
if (op === undefined || op.undone) continue;               // already gone
if (op.kind === 'stroke' && !log.isVisible(op)) continue;  // masked by a clear
// redo candidate
if (op === undefined || !op.undone) continue;                 // already back
if (op.kind === 'stroke' && op.seq <= activeClearSeq) continue; // would stay hidden
```

Otherwise the entry is skipped and the search continues down the stack. Four
things fall out of that one rule:

| Situation | Outcome |
|---|---|
| Two users press undo in the same instant | The server serialises them. The first claims the top op; the second finds its entry stale, skips it, and undoes the *next* one. Two undos, two distinct ops, never a double-undo and never a no-op. |
| Someone else undid my stroke, then I press "undo mine" | My entry is stale, so it is skipped — I cannot undo it twice. My *redo* still works, so I can put my stroke back. |
| Undo after a clear | Strokes masked by the clear are skipped (undoing them would change no pixels), so the first undo lands on the clear itself — which is what a user expects. |
| An op was dropped by history compaction | `log.get()` returns undefined, the entry is skipped. |

Every one of those rows is a test in `test/drawing-state.test.ts`, plus a
500-iteration randomised storm of interleaved undo/redo across three users that
re-checks the visibility invariant after every single step.

### Why not OT or a CRDT?

Both solve a harder problem than this one has. Strokes are immutable and
non-overlapping in the data model — two strokes drawn in the same place do not
conflict, they just stack — so there is nothing to transform and no merge
function to define. The only mutable field in the entire system is one boolean per
op, and a single server assigns the order. A CRDT would add a large amount of
machinery to arrive at the same guarantees, and would still need a policy decision
about what collaborative undo *means*, which is the actual difficulty.

The cost of this choice is honest: it needs a server, and it does not work
peer-to-peer or offline-first. §11 covers that.

---

## 7. Conflict resolution, in full

| Conflict | Resolution |
|---|---|
| Two users draw over each other | Not a conflict. Both strokes exist; `seq` decides who is on top. Later wins, deterministically, everywhere. |
| Simultaneous undo | Serialised by the server; lazy validation makes the second request pick a different op (§6). |
| Eraser vs. a stroke drawn at the same moment | The eraser is an op with a `seq` like any other. It only removes what is *below* it, and a stroke committed after it is unaffected — the same as in any layered editor. |
| A stroke id chosen by a malicious client | `sid` must be prefixed with the sender's user id and must not already exist. Cross-user collisions are structurally impossible; authorship always comes from the connection, never the payload. |
| Same identity in two tabs | The newer connection wins; the older one gets a fatal `superseded` and stops. Presence never shows a phantom duplicate. |
| Client and server disagree about the picture | Detected by the `hv` gap check, repaired by a resync. |
| A client reconnects having missed updates | Delta sync: ops after `since`, plus the ids of *all* currently-undone ops, since visibility of older ops may have changed while it was away. |

---

## 8. Performance decisions

### Rendering: three surfaces, not one

| Surface | Contents | Updated |
|---|---|---|
| `committed` (offscreen) | every committed stroke, at device resolution | incrementally — one path per new op |
| `content` (on-screen) | the dirty rect of `committed`, then live strokes on top | once per animation frame, only if dirty |
| `overlay` (on-screen) | remote cursors, name tags, local brush ring | only when a cursor moves |

- **Committing a stroke does not replay the log.** The new op is drawn straight
  onto the committed raster: O(1) in history size. A canvas with 2000 strokes
  commits the 2001st exactly as fast as the first.
- **Undo does not replay the log either.** It repaints only the undone op's
  bounding box, redrawing just the strokes whose bounds intersect it. On a busy
  canvas that is a handful of paths instead of thousands.
- **Full replay happens in exactly two cases:** a resize (the raster resolution
  changed) and a clear or undo-of-clear (the whole surface is affected).
- **Cursors live on their own surface.** A cursor moving at 20Hz would otherwise
  force a content repaint 20 times a second for zero pixels of drawing. It also
  means a live eraser stroke cannot rub out a cursor.
- **Dirty rectangles everywhere.** The per-frame blit copies only the changed
  region; the `repaint` stat in the sidebar shows the fraction of the surface
  touched by the last frame — typically 1–3% while drawing.
- **Bounds are inflated by two device pixels** before any clear, clip or blit. Op
  bounds are padded in *world* units because they travel on the wire, and when the
  paper is displayed small that padding is less than one device pixel — so an undo
  used to leave an antialiased fringe behind. The browser tests caught it.

### Smoothing

Quadratic curves through segment midpoints, with the raw samples as control
points. One curve per point, no lookahead — which matters because it means a
stroke renders identically whether it arrives all at once or three points at a
time, so a live remote stroke never visibly "re-shapes" as it streams in.

### Input

- `getCoalescedEvents()` recovers the samples the browser merged into one
  `pointermove`. At 120Hz that is 8–10 real samples per frame; without it fast
  strokes visibly lose detail.
- Points closer than 0.75 world units are dropped **at the source**, before they
  are stored, sent, or drawn.
- Outgoing points are batched at 30Hz (33ms). 30Hz is indistinguishable from 90Hz
  to a viewer and costs a third of the traffic. `end` is sent immediately, never
  batched, so a finished stroke never waits.

### Network

- One frame per tick, both directions (array batching, §3).
- The server rebroadcasts only the points it actually *kept* after thinning.
- `perMessageDeflate` is off: frames are small and latency-sensitive, and deflate
  costs CPU plus a compression context per socket.
- Cursor messages are throttled separately from drawing traffic and bypass the
  rate-limit bucket, so cursor spam can never starve drawing.
- Content-hashed asset filenames, so the bundle is `immutable` and the HTML shell
  is `no-cache`.

### Bounds on resource use

Per connection: a 240-message burst / 160-per-second token bucket, a 96KB frame
cap, ≤200 messages per batched frame, ≤4 concurrent strokes. Per room: 4000 points
per stroke, 5000 ops, 300k points. When the op budget runs low and a clear is
active, the ops masked by that clear are compacted away — they are invisible and
can only return by undoing past the clear, so no pixel can change and only
history older than the last clear is lost. If nothing is masked, nothing is
dropped and new strokes are refused with an explanatory error instead.

---

## 9. Two transports

### WebSocket (`npm start`, or any host that keeps a process alive)

The real thing: full duplex, sub-millisecond local latency, one connection per
user. 25-second ping sweep terminates half-open sockets (sleeping laptops, dead
Wi-Fi).

### SSE + POST (Vercel)

Vercel Functions terminate HTTP and cannot accept a WebSocket upgrade, so the
client falls back to:

```
GET  /api/rt?mode=stream&room=&cid=&sid=&since=   →  text/event-stream (downstream)
POST /api/rt   { sid, msgs: [...] }               →  batched upstream
```

Opening the stream *is* the `hello`, since SSE has no upstream channel — the query
string carries what the frame would have.

Both halves live in **one function file** deliberately: every file under `api/`
becomes its own lambda, and two lambdas cannot share the in-memory room state that
a POST needs in order to find its stream's session.

The stream closes itself after ~50s with a `reconnect` message, before the
platform's wall-clock limit can kill it; the client reopens immediately with
`since` set and gets a delta. The user sees nothing.

The client picks a transport once: an explicit `?transport=`, a value memoised in
`sessionStorage` from earlier in the session, an injected `PUBLIC_WS_URL`, or —
by default — it tries WebSocket and falls back if the handshake has not landed in
2.5 seconds. On Vercel the upgrade fails immediately, so the fallback is not
perceptible.

### The serverless limitation, stated plainly

Room state lives in the instance's memory. A stream and its POSTs must land on the
same warm instance for the room to be consistent. `regions: ["iad1"]` plus Fluid
Compute request packing make that the normal case for a small room, and a POST
that lands elsewhere is refused with a 409 that triggers a reconnect and resync
rather than silently forking the canvas. But it is not a guarantee, and a busy
deployment can scale to a second instance whose room is a different room.

The fix is one environment variable, not a rewrite: set `PUBLIC_WS_URL` to a
WebSocket server (Render, Railway, Fly, a VM) and the static Vercel page connects
there instead, with the full consistency of §4. The same code serves both.

---

## 10. Failure handling

| Failure | Behaviour |
|---|---|
| Connection drops | Exponential backoff with full jitter, 300ms → 8s. Reconnect resumes with `since`, so only the delta is sent. |
| Drawing when the connection dies | The stroke keeps rendering locally. On reconnect it is re-issued under a fresh id with every point captured so far — the drawing continues with no visible break. |
| Server restarts under a client | `version_mismatch` if the protocol changed (the page reloads itself), otherwise a normal reconnect. |
| Half-open socket | 5s pings; no pong within 15s forces a reconnect. Server-side, a 25s ping sweep terminates the socket. |
| Tab backgrounded for a while | On wake, a resync is requested before drawing on top of a possibly stale picture. |
| A user vanishes mid-stroke | Their in-flight stroke is cancelled for everyone and the region repainted. |
| Malformed or hostile input | Sanitised at the door; a protocol error is reported and, after 20 of them, the connection is closed. Oversized frames are refused. |
| A room empties | State is kept for 30 minutes, and a user's colour/name for 10, so a refresh does not wipe the drawing. |

---

## 11. Known trade-offs

- **Needs an authoritative server.** No offline-first or peer-to-peer operation.
  In exchange, ordering and undo semantics are simple and provable.
- **No authentication.** `clientId` is self-asserted, so identity is spoofable by
  anyone who wants to. Fine for an open whiteboard, not for private rooms.
- **History is bounded** (§8), so a very long session eventually loses the ability
  to undo past the last clear.
- **One width per stroke.** Pressure sensitivity would need a per-point width in
  the protocol and a variable-width path renderer.
- **Serverless consistency** is best-effort (§9).

## 12. What I would build next

1. A shared state backend (Redis or Durable Objects) behind the existing
   `Connection`/room seam, which would make the serverless path fully consistent.
2. Rasterised snapshots: fold old ops into a baseline image so history can be
   bounded without ever losing pixels.
3. A quadtree over op bounds, so region repaints stop scanning the whole log.
4. Binary framing for `points` (a Float32Array delta encoding) — roughly 4× less
   bandwidth than JSON numbers for the hottest message.
5. Pressure and tilt, which means variable-width paths.
