// The forge server: one shared Store, routed to the five surfaces.
// main.ts (starter, unchanged) binds an ephemeral port, registers it with
// the env, polls /done and exits 0. This file is the server only.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { sendJson, sendError } from './src/http.ts';
import { handleGit } from './src/git.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

function pathOf(req: IncomingMessage): string {
  try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; }
}

function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      try {
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        const rawBody = await readBody(req);
        let handled = false;
        if (path === '/mcp') {
          handled = await handleMcp(store, req, res, rawBody);
        } else if (path === '/api/graphql') {
          handled = await handleGraphQL(store, req, res, rawBody);
        } else if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          handled = await handleRest(store, req, res, rawBody);
        } else if (/^\/[^/]+\/[^/]+\.git(\/|$)/.test(path)) {
          handled = await handleGit(store, req, res, rawBody);
        }
        if (!handled && !res.writableEnded) {
          sendJson(res, 404, { message: 'Not Found' });
        }
      } catch (err) {
        if (!res.writableEnded) {
          try { sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error'); } catch { /* socket gone */ }
        }
      }
    })();
  });
}
