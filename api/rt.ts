/**
 * Vercel Function: the whole realtime transport in one lambda.
 *
 *   GET  /api/rt?mode=stream&room=&cid=&sid=&since=  -> SSE downstream
 *   GET  /api/rt?mode=health                         -> JSON stats
 *   POST /api/rt  { sid, msgs: [...] }               -> upstream batch
 *
 * GET and POST must be handled by the *same* function file: every file under
 * `api/` becomes its own lambda, and two lambdas cannot share the in-memory room
 * state that a POST needs to find its SSE session.
 *
 * All the logic lives in `server/serverless.ts`, which the long-lived Express
 * server mounts at this same path — one code path, two deployment shapes.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleRealtimeRequest } from '../server/serverless.js';

export const config = {
  // Node runtime (not Edge): we need `setInterval`, `setImmediate` and a plain
  // Node stream to hold the SSE response open.
  runtime: 'nodejs',
  maxDuration: 60,
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleRealtimeRequest(req, res);
}
