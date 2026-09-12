/**
 * Development runner: build once, then watch everything.
 *
 *   - the client is rebuilt by esbuild on any change under client/
 *   - the server is recompiled by `tsc --watch`
 *   - `node --watch` restarts the server process when dist/ changes
 *
 * Kept as a small script rather than a task runner dependency: three child
 * processes and one signal handler is the whole story.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClient } from './build-client.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const children = [];

function run(label, command, args) {
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const prefix = `[${label}]`;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length > 0) console.log(`${prefix} ${line}`);
      }
    });
  }
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.log(`${prefix} exited with ${code}`);
  });
  children.push(child);
  return child;
}

function shutdown() {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('dev: initial build…');
await buildClient();

// Compile the server once before starting it, so `node --watch` has something to run.
await new Promise((resolve, reject) => {
  const tsc = spawn('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' });
  tsc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tsc exited with ${code}`))));
});

run('client', 'node', ['scripts/build-client.mjs', '--watch']);
run('tsc', 'npx', ['tsc', '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput']);
run('server', 'node', ['--watch', '--watch-path', 'dist/server', 'dist/server/server.js']);

console.log('dev: watching. Ctrl+C to stop.');
