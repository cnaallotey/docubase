import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { main } from '../src/cli.js';
import { start } from '../src/start.js';

const quiet = { log: { log() {}, warn() {}, error() {} } };

async function builtSite(config) {
  const root = await mkdtemp(path.join(tmpdir(), 'docubase-mcp-http-'));
  const files = {
    'docubase.config.json': JSON.stringify({ title: 'Acme', ...config }),
    'index.md': '# Home\n\nWelcome to Acme.',
    'guides/deploy.md': '---\ntitle: Deploying\ndescription: Ship it.\n---\n\n## Docker\n\nRun `docker run acme/app` and open port 8080.',
    'secret.md': '---\nhidden: true\n---\n# Secret\n\nThe hidden zebra plan.',
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  assert.equal(await main(['build', root], quiet), 0);
  return root;
}

function rpc(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('the MCP SDK client can search and read the docs over Streamable HTTP', async () => {
  const root = await builtSite({ mcp: { enabled: true } });
  const server = await start(root, { port: 0, ...quiet });
  const client = new Client({ name: 'test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}__docubase/mcp`)));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['get_page', 'list_pages', 'search_docs']);

    const found = await client.callTool({ name: 'search_docs', arguments: { query: 'docker' } });
    assert.match(found.content[0].text, /path: guides\/deploy/);

    const page = await client.callTool({ name: 'get_page', arguments: { path: 'guides/deploy' } });
    assert.match(page.content[0].text, /^# Deploying/);
    assert.match(page.content[0].text, /docker run acme\/app/);

    const list = await client.callTool({ name: 'list_pages', arguments: {} });
    assert.match(list.content[0].text, /guides\/deploy: Deploying\. Ship it\./);
    assert.ok(!list.content[0].text.includes('zebra') && !list.content[0].text.includes('secret'), 'hidden pages stay out of the list');
  } finally {
    await client.close();
    await server.close();
  }
});

test('the MCP endpoint is off unless the config turns it on, and its data file only exists then', async () => {
  const root = await builtSite({});
  await assert.rejects(access(path.join(root, 'dist', 'docubase-mcp.json')));
  const server = await start(root, { port: 0, ...quiet });
  try {
    const res = await rpc(`${server.url}__docubase/mcp`, { jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(res.status, 405, 'falls through to the static server, which only takes GET');
  } finally {
    await server.close();
  }
});

test('the MCP endpoint follows the transport rules and refuses what it should', async () => {
  const root = await builtSite({ base: '/docs/', mcp: { enabled: true, rateLimitPerMinute: 8, allowedOrigins: ['https://agent.example'] } });
  const server = await start(root, { port: 0, ...quiet });
  const url = `${server.url}__docubase/mcp`;
  assert.match(url, /\/docs\/__docubase\/mcp$/);
  try {
    assert.equal((await fetch(url)).status, 405, 'no server-initiated stream');
    assert.equal((await fetch(url, { method: 'DELETE' })).status, 405, 'no sessions to end');

    const init = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    assert.equal(init.status, 200);
    assert.equal(init.headers.get('mcp-protocol-version'), '2025-03-26');
    assert.equal((await init.json()).result.serverInfo.name, 'docubase');

    assert.equal((await rpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202, 'notifications get 202 and no body');
    assert.equal((await rpc(url, 'not json')).status, 400);
    assert.equal((await rpc(url, { jsonrpc: '2.0', id: 2, method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);

    const foreign = await rpc(url, { jsonrpc: '2.0', id: 3, method: 'ping' }, { origin: 'https://evil.example' });
    assert.equal(foreign.status, 403, 'browsers on other sites are refused');
    const listed = await rpc(url, { jsonrpc: '2.0', id: 4, method: 'ping' }, { origin: 'https://agent.example' });
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get('access-control-allow-origin'), 'https://agent.example');

    let limited = null;
    for (let i = 0; i < 10 && !limited; i++) {
      const res = await rpc(url, { jsonrpc: '2.0', id: 10 + i, method: 'ping' });
      if (res.status === 429) limited = res;
    }
    assert.ok(limited, 'the rate limit applies');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  } finally {
    await server.close();
  }
});

test('an invalid mcp config stops the build with a clear message', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'docubase-mcp-bad-'));
  await writeFile(path.join(root, 'docubase.config.json'), JSON.stringify({ mcp: { enabled: 'yes' } }));
  await writeFile(path.join(root, 'index.md'), '# Home');
  const errors = [];
  const code = await main(['build', root], { log: { log() {}, warn() {}, error: (m) => errors.push(String(m)) } });
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /"mcp.enabled" must be true or false/);
});
