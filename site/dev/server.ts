import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { application } from '../functions/lib/routes.ts';
import { MemoryDb } from './memory-db.ts';
import { StubModel } from './stub-model.ts';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const PORT = Number(process.env.ATLAS_SITE_PORT ?? 7790);
const API_PREFIX = '/functions/v1/app';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const db = new MemoryDb();
const model = new StubModel();
const handler = application({ db, model, clientIp: (request) => request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1' });

async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function handleApi(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await bodyOf(request);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(', '));
  }
  if (!headers.has('x-forwarded-for')) headers.set('x-forwarded-for', '127.0.0.1');
  const webRequest = new Request(`http://127.0.0.1:${PORT}${request.url ?? API_PREFIX}`, {
    method: request.method,
    headers,
    body: body && body.length ? body.toString('utf8') : undefined,
  });
  const webResponse = await handler(webRequest);
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => response.setHeader(key, value));
  response.end(Buffer.from(await webResponse.arrayBuffer()));
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (!extname(rel)) rel = `${rel}.html`;
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = resolve(join(DIST, safe));
  if (!file.startsWith(resolve(DIST))) {
    response.statusCode = 403;
    response.end('forbidden');
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const bytes = await readFile(file);
    response.statusCode = 200;
    response.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    response.setHeader('cache-control', 'no-store');
    response.end(bytes);
  } catch {
    response.statusCode = 404;
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end('not found');
  }
}

const server = createServer((request, response) => {
  void (async () => {
    try {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
      if (url.pathname === '/__dev/reset' && request.method === 'POST') {
        db.reset();
        response.statusCode = 200;
        response.setHeader('content-type', 'text/plain; charset=utf-8');
        response.end('reset\n');
        return;
      }
      if (url.pathname === '/__dev/state' && request.method === 'GET') {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ tables: db.tables }));
        return;
      }
      if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
        await handleApi(request, response);
        return;
      }
      await serveStatic(url.pathname, response);
    } catch (error) {
      response.statusCode = 500;
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end(`server error: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`thought-atlas site: http://127.0.0.1:${PORT} (stub model, memory db)`);
});