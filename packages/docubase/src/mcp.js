import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadSite, pageMarkdown } from '@docubase/core';
import MiniSearch from 'minisearch';

/**
 * A local Model Context Protocol server over stdio. It lets a coding agent search and read the docs
 * in this folder without a network. It only reads, and it never writes anything to stdout except
 * protocol messages, because stdout belongs to the client.
 */

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LINE = 4 * 1024 * 1024;

const TOOLS = [
  {
    name: 'search_docs',
    description: 'Search the documentation and return the best matching sections with their page paths. Use get_page to read a whole page.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'How many results to return. Default 5.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_page',
    description: 'Read one documentation page as Markdown. Pass a path from search_docs or list_pages, such as "guides/writing".',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Page path, for example guides/writing' } },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_pages',
    description: 'List every documentation page with its path and description.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

function pagePath(page) {
  return page.slug || 'index';
}

/** Accept "guides/writing", "/guides/writing/", "guides/writing.md" or "guides/index.md". */
function normalizePath(input, base) {
  let value = String(input).trim();
  if (value.startsWith(base)) value = value.slice(base.length);
  value = value.replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '').replace(/\.(md|mdx)$/i, '').replace(/\/?index$/, '');
  return value;
}

export function createMcpHandler({ getSite, version = '0.0.0' }) {
  let cachedFor = null;
  let search = null;

  function searcher(site) {
    if (cachedFor !== site) {
      search = MiniSearch.loadJS(site.search.index, site.search.options);
      cachedFor = site;
    }
    return search;
  }

  function toolSearch(args) {
    if (typeof args.query !== 'string' || !args.query.trim()) return fail('"query" must be a non-empty string.');
    if (args.query.length > 300) return fail('"query" is too long. Use up to 300 characters.');
    const limit = args.limit === undefined ? 5 : args.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) return fail('"limit" must be a whole number from 1 to 10.');
    const site = getSite();
    const hits = searcher(site).search(args.query.trim()).slice(0, limit);
    if (hits.length === 0) return ok(`No results for "${args.query.trim()}". Try other words, or call list_pages.`);
    const bySlugUrl = new Map(site.pages.map((p) => [p.url, p]));
    const lines = hits.map((hit, i) => {
      const [pageUrl] = String(hit.url).split('#');
      const page = bySlugUrl.get(pageUrl);
      const where = page ? pagePath(page) : hit.url;
      const heading = hit.heading ? ` > ${hit.heading}` : '';
      return `${i + 1}. ${hit.title}${heading}\n   path: ${where}\n   ${hit.excerpt || ''}`.trimEnd();
    });
    return ok(lines.join('\n\n'));
  }

  function toolGetPage(args) {
    if (typeof args.path !== 'string' || !args.path.trim()) return fail('"path" must be a non-empty string.');
    const site = getSite();
    const wanted = normalizePath(args.path, site.config.base);
    const page = site.pages.find((p) => p.slug === wanted);
    if (!page) {
      const sample = site.pages.filter((p) => !p.hidden).slice(0, 8).map(pagePath).join(', ');
      return fail(`No page at "${args.path}". Call list_pages for the full list. Some paths: ${sample}`);
    }
    return ok(page.rendered ?? pageMarkdown(page));
  }

  function toolList() {
    const site = getSite();
    const bySlug = new Map(site.pages.map((p) => [p.slug, p]));
    const lines = site.nav.flat.map((entry) => {
      const page = bySlug.get(entry.slug);
      if (!page) return null;
      return `- ${pagePath(page)}: ${page.title}${page.hasDescription && page.description ? `. ${page.description}` : ''}`;
    }).filter(Boolean);
    return ok(lines.join('\n'));
  }

  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });
  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  /** Handle one JSON-RPC message. Returns the response, or null for notifications. */
  async function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
      return rpcError(message && message.id !== undefined ? message.id : null, -32600, 'Invalid request');
    }
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;
    if (typeof method !== 'string') return isNotification ? null : rpcError(id, -32600, 'Invalid request');
    if (isNotification) return null; // initialized, cancelled and similar need no reply

    switch (method) {
      case 'initialize': {
        const asked = params && params.protocolVersion;
        const protocolVersion = SUPPORTED.includes(asked) ? asked : SUPPORTED[0];
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'docubase', version },
            instructions: 'Search and read the documentation of this project. Start with search_docs, then get_page for the full text.',
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      case 'tools/call': {
        const name = params && params.name;
        const args = params && params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        try {
          if (name === 'search_docs') return { jsonrpc: '2.0', id, result: toolSearch(args) };
          if (name === 'get_page') return { jsonrpc: '2.0', id, result: toolGetPage(args) };
          if (name === 'list_pages') return { jsonrpc: '2.0', id, result: toolList() };
        } catch (error) {
          return { jsonrpc: '2.0', id, result: fail(`The docs could not be read: ${error.message}`) };
        }
        return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  return { handle };
}

/* ------------------------------------------------------------------ HTTP */

const HTTP_BODY_LIMIT = 1024 * 1024;

function normalizeOrigin(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * The hosted MCP endpoint: the Streamable HTTP transport, answered statelessly with plain JSON.
 * Each POST carries JSON-RPC messages and gets the replies back in the same response. There is no
 * session and no server-to-client stream, so GET and DELETE answer 405 as the protocol allows.
 *
 * `getHandler` returns the result of createMcpHandler, so a host can swap the docs after a deploy.
 */
export function createMcpHttp({ getHandler, rateLimitPerMinute = 120, allowedOrigins = [], trustProxy = false, clientIp: customIp = null }) {
  const hits = new Map();

  function clientIp(req) {
    if (customIp) return customIp(req);
    if (trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function limited(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
    if (recent.length >= rateLimitPerMinute) {
      hits.set(ip, recent);
      return Math.max(1, Math.ceil((60000 - (now - recent[0])) / 1000));
    }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) {
      for (const [key, times] of hits) if (times.every((t) => now - t >= 60000)) hits.delete(key);
      if (hits.size > 5000) hits.clear();
    }
    return 0;
  }

  /** Requests from tools carry no Origin. A browser page may call only from this site or a listed origin. */
  function originAllowed(origin, host) {
    const normalized = normalizeOrigin(origin);
    if (!normalized) return false;
    if (host && new URL(normalized).host === String(host).toLowerCase()) return true;
    return allowedOrigins.some((o) => normalizeOrigin(o) === normalized);
  }

  async function readBody(req) {
    const parts = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > HTTP_BODY_LIMIT) {
        req.resume();
        return null;
      }
      parts.push(chunk);
    }
    return Buffer.concat(parts).toString('utf8');
  }

  return async function handle(req, res) {
    const cors = {};
    const origin = req.headers.origin;
    if (origin) {
      if (!originAllowed(origin, req.headers.host)) return sendJson(res, 403, { error: 'This origin is not allowed to use the MCP endpoint.' });
      cors['access-control-allow-origin'] = origin;
      cors['access-control-expose-headers'] = 'mcp-protocol-version';
      cors.vary = 'Origin';
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type, accept, mcp-protocol-version',
        'access-control-max-age': '600',
      });
      return res.end();
    }
    if (req.method !== 'POST') {
      // No server-initiated stream and no sessions, which the transport allows.
      return sendJson(res, 405, { error: 'This MCP endpoint takes POST requests with JSON-RPC messages.' }, { ...cors, allow: 'POST, OPTIONS' });
    }
    const version = req.headers['mcp-protocol-version'];
    if (version !== undefined && !SUPPORTED.includes(String(version))) {
      return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `Unsupported MCP-Protocol-Version. Supported: ${SUPPORTED.join(', ')}` } }, cors);
    }
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      return sendJson(res, 415, { error: 'Send JSON-RPC with content-type application/json.' }, cors);
    }
    const wait = limited(clientIp(req));
    if (wait > 0) return sendJson(res, 429, { error: 'Too many requests. Wait a moment and try again.' }, { ...cors, 'retry-after': String(wait) });

    const raw = await readBody(req);
    if (raw === null) return sendJson(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Message too large' } }, { ...cors, connection: 'close' });
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, cors);
    }

    const batch = Array.isArray(message);
    const items = batch ? message : [message];
    if (items.length === 0 || items.length > 50) {
      return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Send between 1 and 50 messages' } }, cors);
    }
    const handler = await getHandler();
    const replies = [];
    for (const item of items) {
      // Replies from the client to a server request would arrive here. This server sends none, so they need no answer.
      if (item && typeof item === 'object' && !('method' in item) && ('result' in item || 'error' in item)) continue;
      const reply = await handler.handle(item);
      if (reply) replies.push(reply);
    }
    if (replies.length === 0) {
      res.writeHead(202, { ...cors, 'cache-control': 'no-store' });
      return res.end();
    }
    const negotiated = items.find((i) => i && i.method === 'initialize') ? replies.find((r) => r.result?.protocolVersion)?.result.protocolVersion : version;
    return sendJson(res, 200, batch ? replies : replies[0], { ...cors, ...(negotiated ? { 'mcp-protocol-version': String(negotiated) } : {}) });
  };
}

export async function packageVersion() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  return JSON.parse(await readFile(file, 'utf8')).version;
}

/**
 * Run the server on stdio until the client closes the pipe.
 * @returns {Promise<{ close: () => void, done: Promise<void> }>}
 */
export async function runMcp(root, { watchFiles = false, input = process.stdin, output = process.stdout, log = console } = {}) {
  let site = await loadSite(root);
  for (const warning of site.warnings) log.warn(`warning: ${warning}`);
  const handler = createMcpHandler({ getSite: () => site, version: await packageVersion() });

  const write = (message) => output.write(`${JSON.stringify(message)}\n`);

  let watcher = null;
  let timer = null;
  if (watchFiles) {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (filename.split(path.sep).some((p) => p === 'node_modules' || p === '.git' || p === 'dist')) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          site = await loadSite(root);
          log.error(`docubase mcp: reloaded ${site.pages.length} pages`);
        } catch (error) {
          log.error(`docubase mcp: reload failed, keeping the previous version (${error.message})`);
        }
      }, 150);
    });
  }

  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const done = new Promise((resolve) => lines.once('close', resolve));

  lines.on('line', async (line) => {
    if (!line.trim()) return;
    if (line.length > MAX_LINE) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Message too large' } });
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const batch = Array.isArray(message);
    const replies = [];
    for (const item of batch ? message : [message]) {
      const reply = await handler.handle(item);
      if (reply) replies.push(reply);
    }
    if (replies.length === 0) return;
    write(batch ? replies : replies[0]);
  });

  return {
    done,
    close() {
      clearTimeout(timer);
      watcher?.close();
      lines.close();
    },
  };
}
