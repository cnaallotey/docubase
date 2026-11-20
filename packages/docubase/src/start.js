import { createServer } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DocubaseError, loadConfig } from '@docubase/core';
import { createAssistant, keyIsOptional, missingKeyMessage, resolveApiKey } from './assistant.js';
import { CHUNKS_FILE, MCP_FILE } from './build.js';
import { createMcpHandler, createMcpHttp, packageVersion } from './mcp.js';
import { decodePath, serveStatic } from './static.js';

/**
 * Serve a built site and, when the assistant is turned on, answer questions at /__docubase/ask.
 * This is the command to run on a server. Static hosts that cannot run Node can still host the
 * site itself and point "assistant.endpoint" at a server running this command.
 */
export async function start(root, { out, port = 3000, host = '127.0.0.1', env = process.env, fetchImpl, log = console } = {}) {
  const config = await loadConfig(root);
  const outDir = path.resolve(out ?? path.resolve(root, config.outDir));

  try {
    await access(path.join(outDir, '.docubase-build'));
  } catch {
    throw new DocubaseError(`There is no built site in ${outDir}. Run "docubase build" first.`);
  }

  const assistant = createAssistant({ env, fetchImpl, log });
  const ai = config.assistant;
  if (ai.enabled) {
    if (!resolveApiKey(ai, env) && !keyIsOptional(ai)) throw new DocubaseError(missingKeyMessage(ai));
    let chunks;
    try {
      chunks = JSON.parse(await readFile(path.join(outDir, CHUNKS_FILE), 'utf8'));
    } catch {
      throw new DocubaseError(`The assistant is turned on but ${CHUNKS_FILE} is missing from the build. Run "docubase build" again.`);
    }
    assistant.configure(config, chunks);
  }

  let mcp = null;
  if (config.mcp.enabled) {
    let snapshot;
    try {
      snapshot = JSON.parse(await readFile(path.join(outDir, MCP_FILE), 'utf8'));
    } catch {
      throw new DocubaseError(`The MCP endpoint is turned on but ${MCP_FILE} is missing from the build. Run "docubase build" again.`);
    }
    const handler = createMcpHandler({ getSite: () => snapshot, version: await packageVersion() });
    mcp = createMcpHttp({ getHandler: () => handler, ...config.mcp });
  }

  const base = config.base;
  const mcpRoute = `${base}__docubase/mcp`;
  const askRoute = config.assistant.endpoint && config.assistant.endpoint.startsWith('/') ? config.assistant.endpoint : `${base}__docubase/ask`;
  const prefix = base.slice(0, -1);

  const server = createServer(async (req, res) => {
    try {
      const pathname = decodePath(req.url);
      if (pathname === null) {
        res.writeHead(400).end('Bad request');
        return;
      }
      if (pathname === askRoute) {
        await assistant.handle(req, res);
        return;
      }
      if (mcp && pathname === mcpRoute) {
        await mcp(req, res);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' }).end('Method not allowed');
        return;
      }
      if (prefix && pathname === prefix) {
        res.writeHead(301, { location: base }).end();
        return;
      }
      if (!pathname.startsWith(base)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`Not found. This site is served under ${base}`);
        return;
      }
      await serveStatic(res, outDir, pathname.slice(base.length - 1), { prefix });
    } catch (error) {
      log.error(`error: ${error.message}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Server error');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') reject(new DocubaseError(`Port ${port} is already in use. Try --port ${port + 1}.`));
      else reject(error);
    });
    server.listen(port, host, resolve);
  });

  const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  const url = `http://${shown}:${server.address().port}${base}`;
  log.log(`Serving ${outDir}\n  ${url}`);
  log.log(ai.enabled ? `  Assistant: on (${ai.provider}, ${ai.model})` : '  Assistant: off');
  log.log(mcp ? `  MCP endpoint: ${url}__docubase/mcp` : '  MCP endpoint: off');

  return {
    url,
    async close() {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    },
  };
}
