import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const mimeTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.mmd': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.srt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8', '.pdf': 'application/pdf', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function serveDirectory(directory: string, port: number): Promise<void> {
  const root = await realpath(directory);
  if (!(await lstat(root)).isDirectory()) throw new Error('Serve target must be a directory.');
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    const reject = (code: number, message: string) => { response.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end(request.method === 'HEAD' ? '' : message); };
    if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.setHeader('Allow', 'GET, HEAD'); reject(405, 'Method not allowed.'); return; }
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(request.headers.host ?? '')) { reject(403, 'Invalid host.'); return; }
    try {
      const raw = (request.url ?? '/').split('?')[0]!;
      const decoded = decodeURIComponent(raw);
      const parts = decoded.split('/');
      if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.includes('\\') || /[\x00-\x1f:]/.test(decoded) || parts.some(part => part.startsWith('.'))) { reject(403, 'Path not allowed.'); return; }
      let relative = decoded.slice(1);
      if (!relative) {
        for (const candidate of ['playbook.html', 'overview.html', 'index.html']) {
          try { if ((await lstat(path.join(root, candidate))).isFile()) { relative = candidate; break; } } catch { /* Try the next document. */ }
        }
      }
      let target = path.resolve(root, relative);
      if ((await lstat(target)).isDirectory()) {
        if (!decoded.endsWith('/')) { response.writeHead(302, { Location: decoded + '/' }); response.end(); return; }
        target = path.join(target, 'index.html');
      }
      const extension = path.extname(target).toLowerCase();
      if (['.js', '.css', '.svg', '.woff', '.woff2', '.ttf'].includes(extension) && (!/^[^/]+-site\/assets\//.test(relative))) { reject(404, 'Asset not found.'); return; }
      if (!contained(root, target)) { reject(403, 'Path outside preview.'); return; }
      const resolved = await realpath(target);
      if (!contained(root, resolved)) { reject(403, 'Link outside preview.'); return; }
      const info = await lstat(resolved);
      const mime = path.basename(resolved) === 'THIRD-PARTY-NOTICES.txt' ? 'text/plain; charset=utf-8' : mimeTypes[path.extname(resolved).toLowerCase()];
      if (!info.isFile() || !mime) { reject(404, 'Document not found.'); return; }
      response.writeHead(200, { 'Content-Type': mime, 'Content-Length': info.size });
      if (request.method === 'HEAD') response.end();
      else createReadStream(resolved).on('error', () => response.destroy()).pipe(response);
    } catch (error) { reject(error instanceof URIError ? 400 : 404, 'Document not found.'); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Preview address unavailable.');
  console.log(JSON.stringify({ serving: root, url: `http://127.0.0.1:${address.port}/`, port: address.port, host: '127.0.0.1' }));
  const shutdown = () => { server.close(() => process.exit(0)); server.closeAllConnections(); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
