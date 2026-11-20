import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
};

/** Files that exist in the output folder but are not meant to be downloaded. */
const PRIVATE = new Set(['.docubase-build']);

async function send(res, file, { status = 200, cache, transformHtml }) {
  const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  let body = await readFile(file);
  if (transformHtml && type.startsWith('text/html')) body = Buffer.from(transformHtml(body.toString('utf8')));
  const headers = { 'content-type': type, 'cache-control': cache, 'x-content-type-options': 'nosniff' };
  // An SVG opened on its own can run scripts. Shown in an <img> it cannot, and this keeps it that way when someone navigates to it.
  if (type === 'image/svg+xml') headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  res.writeHead(status, headers);
  res.end(body);
}

/**
 * Serve a file from a built site folder. `pathname` is already decoded and has any base path removed.
 * Unknown paths get 404.html with a 404 status. Paths that leave the folder get 403.
 */
export async function serveStatic(res, dir, pathname, { cache = 'no-cache', transformHtml, prefix = '' } = {}) {
  const wanted = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  const file = path.join(dir, wanted);
  const relative = path.relative(dir, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (PRIVATE.has(relative)) {
    await send(res, path.join(dir, '404.html'), { status: 404, cache, transformHtml });
    return;
  }

  // Versioned theme files never change under the same address.
  const fileCache = cache !== 'no-store' && relative.startsWith(`assets${path.sep}`) ? 'public, max-age=31536000, immutable' : cache;
  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      res.writeHead(301, { location: `${prefix}${pathname}/` }).end();
      return;
    }
    await send(res, file, { cache: fileCache, transformHtml });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ERR_INVALID_ARG_VALUE') {
      try {
        await send(res, path.join(dir, '404.html'), { status: 404, cache, transformHtml });
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      }
    } else {
      throw error;
    }
  }
}

export function decodePath(url) {
  try {
    return decodeURIComponent(new URL(url, 'http://localhost').pathname);
  } catch {
    return null;
  }
}
