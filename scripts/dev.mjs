import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!path.startsWith(root + sep) || pathname.split('/').some((part) => part.startsWith('.')) || !types[extname(path)] || !(await stat(path)).isFile()) {
      response.writeHead(404).end('Not found'); return;
    }
    response.writeHead(200, { 'Content-Type': types[extname(path)], 'Cache-Control': 'no-store' });
    response.end(await readFile(path));
  } catch { response.writeHead(404).end('Not found'); }
}).listen(4173, '127.0.0.1', () => console.log('Local: http://127.0.0.1:4173'));
