#!/usr/bin/env node
// Serves site/dist locally the way Cloudflare Pages would, close enough to check pages and motion.
//   node site/serve.mjs            http://127.0.0.1:8788
import { createServer } from 'node:http';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePath, serveStatic } from '../packages/docubase/src/static.js';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.env.PORT || 8788);
try {
  await access(path.join(dist, 'index.html'));
} catch {
  console.error('No build found. Run: npm run build:site');
  process.exit(1);
}
createServer(async (req, res) => {
  const pathname = decodePath(req.url);
  if (pathname === null) return res.writeHead(400).end('Bad request');
  if (pathname === '/llms.txt') return res.writeHead(302, { location: '/docs/llms.txt' }).end();
  await serveStatic(res, dist, pathname, {});
}).listen(port, '127.0.0.1', () => console.log(`Site preview at http://127.0.0.1:${port}`));
