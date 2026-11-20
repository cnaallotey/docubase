import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSite } from '@docubase/core';
import { createAssistant, keyIsOptional, missingKeyMessage, resolveApiKey } from './assistant.js';
import { build } from './build.js';
import { decodePath, serveStatic } from './static.js';

// Injected into every HTML page in dev. Reloads on rebuild and shows build errors on the page.
const LIVE_RELOAD = `<script>(function(){var s=new EventSource('/__docubase/events');
s.addEventListener('reload',function(){location.reload()});
s.addEventListener('problem',function(e){var b=document.querySelector('.dev-banner');if(!b){b=document.createElement('div');b.className='dev-banner';document.body.appendChild(b)}b.textContent=JSON.parse(e.data)});
s.addEventListener('ok',function(){var b=document.querySelector('.dev-banner');if(b)b.remove()});})();</script>`;

/**
 * Start a local server that rebuilds when files change.
 * Listens on 127.0.0.1 unless a host is given, so the docs are not exposed to the network by accident.
 */
export async function dev(root, { port = 3000, host = '127.0.0.1', log = console } = {}) {
  let current = null;
  let warnedKey = false;
  const clients = new Set();
  const assistant = createAssistant({ log });

  function broadcast(event, data = '') {
    for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  async function rebuild() {
    const started = Date.now();
    try {
      // The dev server always serves from "/", whatever base the production build uses.
      const site = await loadSite(root, { configOverrides: { base: '/' } });
      const out = await mkdtemp(path.join(tmpdir(), 'docubase-dev-'));
      await build(site, { out, safe: false });
      assistant.configure(site.config, site.agents.chunks);
      const ai = site.config.assistant;
      if (ai.enabled && !warnedKey && !resolveApiKey(ai, process.env) && !keyIsOptional(ai)) {
        warnedKey = true;
        log.warn(`warning: ${missingKeyMessage(ai)}`);
      }
      const previous = current;
      current = out;
      if (previous) rm(previous, { recursive: true, force: true }).catch(() => {});
      for (const warning of site.warnings) log.warn(`warning: ${warning}`);
      log.log(`Rebuilt ${site.pages.length} pages in ${Date.now() - started} ms`);
      broadcast('ok');
      return true;
    } catch (error) {
      log.error(`error: ${error.message}`);
      broadcast('problem', error.message);
      return false;
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const pathname = decodePath(req.url);
      if (pathname === null) {
        res.writeHead(400).end('Bad request');
        return;
      }

      if (pathname === '/__docubase/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('retry: 1000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (pathname === '/__docubase/ask') {
        await assistant.handle(req, res);
        return;
      }

      if (!current) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }).end('The first build has not finished or failed. Check the terminal.');
        return;
      }

      await serveStatic(res, current, pathname, { cache: 'no-store', transformHtml: (html) => html.replace('</body>', `${LIVE_RELOAD}</body>`) });
    } catch (error) {
      log.error(`error: ${error.message}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Server error');
    }
  });

  await rebuild();

  let timer = null;
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const parts = filename.split(path.sep);
    if (parts.some((p) => p === 'node_modules' || p === '.git' || p === 'dist')) return;
    clearTimeout(timer);
    timer = setTimeout(rebuild, 120);
  });

  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') reject(new Error(`Port ${port} is already in use. Try --port ${port + 1}.`));
      else reject(error);
    });
    server.listen(port, host, resolve);
  });

  const actualPort = server.address().port;
  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}/`;
  log.log(`Docubase dev server running at ${url}`);

  return {
    url,
    async close() {
      clearTimeout(timer);
      watcher.close();
      for (const res of clients) res.end();
      await new Promise((resolve) => server.close(resolve));
      if (current) await rm(current, { recursive: true, force: true });
    },
  };
}
