import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';
import { start } from '../src/start.js';

const quiet = { log: { log() {}, warn() {}, error() {} } };

async function builtSite(assistant) {
  const root = await mkdtemp(path.join(tmpdir(), 'docubase-stream-'));
  const files = {
    'docubase.config.json': JSON.stringify({ title: 'Acme', assistant }),
    'index.md': '# Home\n\nWelcome.',
    'deploy.md': '# Deploying\n\n## Docker\n\nRun the image with `docker run acme/app` and open port 8080.',
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  assert.equal(await main(['build', root], quiet), 0);
  return root;
}

/**
 * A model provider that streams. `script(body)` returns { status, events } where events are raw
 * SSE strings written one by one with a short pause, or { status, json } for a plain reply.
 */
async function streamingProvider(script) {
  const requests = [];
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
    requests.push({ url: req.url, headers: req.headers, body, closed: false });
    const record = requests.at(-1);
    res.on('close', () => { record.closed = !res.writableEnded; });
    const { status = 200, events, json, hang } = script(body);
    if (json) return res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
    res.writeHead(status, { 'content-type': 'text/event-stream' });
    for (const event of events) {
      if (res.destroyed) return;
      res.write(event);
      await new Promise((r) => setTimeout(r, 5));
    }
    if (!hang) res.end();
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
  };
}

const anthropicEvents = (pieces) => [
  'event: message_start\ndata: {"type":"message_start"}\n\n',
  ...pieces.map((text) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`),
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

const openaiEvents = (pieces) => [
  ...pieces.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`),
  'data: [DONE]\n\n',
];

function ask(url, question, headers = {}) {
  return fetch(`${url}__docubase/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
    body: JSON.stringify({ question }),
  });
}

/** Parse a whole SSE response body into [{ event, data }]. */
async function events(res) {
  const text = await res.text();
  return text.split('\n\n').filter(Boolean).map((block) => {
    const event = /^event: (.*)$/m.exec(block)[1];
    const data = JSON.parse(/^data: (.*)$/m.exec(block)[1]);
    return { event, data };
  });
}

test('Anthropic answers stream as sources, deltas and done', async () => {
  const provider = await streamingProvider(() => ({ events: anthropicEvents(['Run ', '`docker run acme/app`', ' and open 8080.']) }));
  const root = await builtSite({ enabled: true, provider: 'anthropic', model: 'm', baseUrl: provider.url });
  const server = await start(root, { port: 0, env: { ANTHROPIC_API_KEY: 'sk-secret' }, ...quiet });
  try {
    const res = await ask(server.url, 'How do I deploy with docker?');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const got = await events(res);
    assert.equal(got[0].event, 'sources');
    assert.equal(got[0].data[0].url, '/deploy/#docker');
    assert.deepEqual(got.filter((e) => e.event === 'delta').map((e) => e.data.text), ['Run ', '`docker run acme/app`', ' and open 8080.']);
    assert.equal(got.at(-1).event, 'done');

    const sent = provider.requests[0];
    assert.equal(sent.body.stream, true);
    assert.equal(sent.headers['x-api-key'], 'sk-secret');
    assert.equal(JSON.stringify(got).includes('sk-secret'), false);
  } finally {
    await server.close();
    await provider.close();
  }
});

test('OpenAI compatible answers stream too, and JSON is still the default', async () => {
  const provider = await streamingProvider((body) => (body.stream
    ? { events: openaiEvents(['Use ', 'fly deploy.']) }
    : { json: { choices: [{ message: { content: 'Use fly deploy.' } }] } }));
  const root = await builtSite({ enabled: true, provider: 'openai', model: 'llama3', baseUrl: `${provider.url}/v1` });
  const server = await start(root, { port: 0, env: {}, ...quiet });
  try {
    const got = await events(await ask(server.url, 'deploy docker'));
    assert.equal(got.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), 'Use fly deploy.');
    assert.equal(got.at(-1).event, 'done');

    const plain = await ask(server.url, 'deploy docker', { accept: 'application/json' });
    assert.match(plain.headers.get('content-type'), /^application\/json/);
    assert.equal((await plain.json()).answer, 'Use fly deploy.');
    assert.equal(provider.requests[1].body.stream, undefined);
  } finally {
    await server.close();
    await provider.close();
  }
});

test('a question with no match streams the fixed answer without calling the model', async () => {
  const provider = await streamingProvider(() => ({ events: anthropicEvents(['no']) }));
  const root = await builtSite({ enabled: true, provider: 'anthropic', model: 'm', baseUrl: provider.url });
  const server = await start(root, { port: 0, env: { ANTHROPIC_API_KEY: 'k' }, ...quiet });
  try {
    const got = await events(await ask(server.url, 'quantum chromodynamics'));
    assert.deepEqual(got.map((e) => e.event), ['sources', 'delta', 'done']);
    assert.match(got[1].data.text, /could not find anything/);
    assert.equal(provider.requests.length, 0);
  } finally {
    await server.close();
    await provider.close();
  }
});

test('a provider that fails before any text gets a normal 502, one that fails midway gets an error event', async () => {
  let mode = 'early';
  const provider = await streamingProvider(() => (mode === 'early'
    ? { status: 500, json: { error: 'provider detail that must not leak' } }
    : { events: [...anthropicEvents(['Partial ']).slice(0, 2), 'event: error\ndata: {"type":"error","error":{"message":"overloaded secret detail"}}\n\n'] }));
  const root = await builtSite({ enabled: true, provider: 'anthropic', model: 'm', baseUrl: provider.url });
  const errors = [];
  const server = await start(root, { port: 0, env: { ANTHROPIC_API_KEY: 'k' }, log: { log() {}, warn() {}, error: (m) => errors.push(m) } });
  try {
    const early = await ask(server.url, 'deploy docker');
    assert.equal(early.status, 502);
    const body = await early.json();
    assert.match(body.error, /could not answer/);
    assert.equal(JSON.stringify(body).includes('must not leak'), false);

    mode = 'midway';
    const got = await events(await ask(server.url, 'deploy docker'));
    assert.deepEqual(got.map((e) => e.event), ['sources', 'delta', 'error']);
    assert.equal(got[1].data.text, 'Partial ');
    assert.equal(JSON.stringify(got).includes('secret detail'), false);
    assert.ok(errors.every((line) => !line.includes('deploy docker')), 'the question is never logged');
  } finally {
    await server.close();
    await provider.close();
  }
});

test('when the reader goes away the request to the model is cancelled', async () => {
  const provider = await streamingProvider(() => ({ events: anthropicEvents(['First ']).slice(0, 2), hang: true }));
  const root = await builtSite({ enabled: true, provider: 'anthropic', model: 'm', baseUrl: provider.url });
  const server = await start(root, { port: 0, env: { ANTHROPIC_API_KEY: 'k' }, ...quiet });
  try {
    const controller = new AbortController();
    const res = await fetch(`${server.url}__docubase/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ question: 'deploy docker' }),
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    await reader.read(); // the first event has arrived, so the model call is in flight
    controller.abort();
    for (let i = 0; i < 50 && !provider.requests[0].closed; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(provider.requests[0].closed, true, 'the provider connection was closed early');
  } finally {
    await server.close();
    await provider.close();
  }
});
