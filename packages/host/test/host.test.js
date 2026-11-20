import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHost, readSettings, SettingsError } from '../src/index.js';
import { open, parseMasterKey, seal, verifyGithubSignature } from '../src/crypto.js';
import { assertPublicHost, guardedFetch, isPrivateAddress } from '../src/netguard.js';
import { checkBranch, checkDocsDir, parseRepoUrl } from '../src/git.js';

const TOKEN = 'admin-token-for-tests-0123456789';
const MASTER = '0'.repeat(32) + 'a'.repeat(32);
const cleanup = [];
after(async () => {
  for (const fn of cleanup) await fn().catch(() => {});
});

const quiet = { log() {}, warn() {}, error() {} };

async function tmp(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), `docubase-host-${prefix}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' }).toString();

async function repo(files, { dir } = {}) {
  const root = dir ?? (await tmp('repo'));
  git(root, 'init', '-q', '-b', 'main');
  await writeFiles(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return { root, url: `file://${root}` };
}

async function writeFiles(root, files) {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
}

async function commit(root, files, message = 'update') {
  await writeFiles(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD').trim();
}

async function startHost({ env = {}, dataDir, unsafe = { allowFileRepos: true, allowPrivateProviders: true }, buildFn } = {}) {
  const data = dataDir ?? (await tmp('data'));
  const settings = readSettings({
    DOCUBASE_ADMIN_TOKEN: TOKEN,
    DOCUBASE_MASTER_KEY: MASTER,
    DOCUBASE_BASE_DOMAIN: 'docs.test',
    DOCUBASE_DATA_DIR: data,
    PORT: '0',
    ...env,
  });
  const host = createHost({ settings, log: quiet, unsafeForTests: unsafe, buildFn });
  const { port } = await host.start();
  cleanup.push(() => host.close());
  return { host, port, data };
}

/** An HTTP request with a chosen Host header, since sites are chosen by hostname. */
function call(port, method, pathName, { host = 'admin.docs.test', headers = {}, body, json, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const payload = json !== undefined ? JSON.stringify(json) : body;
    const req = httpRequest({ host: '127.0.0.1', port, method, path: pathName, headers: {
      host,
      ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {}),
      ...headers,
    } }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json: parsed });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const DOCS = {
  'index.md': '# Welcome\n\nHello from the hosted docs.',
  'guide.md': '---\ntitle: Guide\n---\n\n## Install\n\nRun the installer.',
};

async function createSite(port, host, body) {
  const res = await call(port, 'POST', '/__host/api/sites', { json: body });
  assert.equal(res.status, 201, res.text);
  await host.idle();
  return res.json;
}

/* ------------------------------------------------------------------ builds and serving */

test('a site is built from git and served at its own hostname, with Markdown routes and llms.txt', async () => {
  const r = await repo(DOCS);
  const { host, port } = await startHost();
  const created = await createSite(port, host, { slug: 'demo', repo: r.url });
  assert.equal(created.site.url, 'https://demo.docs.test');
  assert.ok(created.webhook.secret.length >= 30);

  const home = await call(port, 'GET', '/', { host: 'demo.docs.test', auth: false });
  assert.equal(home.status, 200);
  assert.match(home.text, /Hello from the hosted docs/);
  assert.match(home.text, /href="\/assets\/docubase\.css/, 'the site is built for the root of its own hostname');
  assert.equal(home.headers['x-content-type-options'], 'nosniff');
  assert.equal(home.headers['x-frame-options'], 'SAMEORIGIN');

  assert.match((await call(port, 'GET', '/guide.md', { host: 'demo.docs.test', auth: false })).text, /^# Guide/);
  assert.match((await call(port, 'GET', '/llms.txt', { host: 'demo.docs.test', auth: false })).text, /\[Guide\]/);
  assert.equal((await call(port, 'GET', '/nope/', { host: 'demo.docs.test', auth: false })).status, 404);
  assert.equal((await call(port, 'GET', '/', { host: 'unknown.docs.test', auth: false })).status, 404);
  assert.equal((await call(port, 'POST', '/', { host: 'demo.docs.test', auth: false, json: {} })).status, 405);

  const status = await call(port, 'GET', '/__host/api/sites/demo');
  assert.equal(status.json.site.status.state, 'ready');
  assert.equal(status.json.site.deploy.pages, 2);
  assert.match(status.json.site.deploy.commit, /^[0-9a-f]{40}$/);
});

test('a docs folder inside the repository can be named with dir', async () => {
  const r = await repo({ 'README.md': 'not docs', 'website/docs/index.md': '# Nested\n\nIn a subfolder.' });
  const { host, port } = await startHost();
  await createSite(port, host, { slug: 'nested', repo: r.url, dir: 'website/docs' });
  const home = await call(port, 'GET', '/', { host: 'nested.docs.test', auth: false });
  assert.match(home.text, /In a subfolder/);
  assert.ok(!home.text.includes('not docs'));

  await createSite(port, host, { slug: 'missing', repo: r.url, dir: 'nothing/here' });
  const failed = await call(port, 'GET', '/__host/api/sites/missing');
  assert.equal(failed.json.site.status.state, 'failed');
  assert.match(failed.json.site.status.error, /does not exist in the repository/);
  assert.equal((await call(port, 'GET', '/', { host: 'missing.docs.test', auth: false })).status, 502);
});

test('a site that is still building answers 503, and a failed rebuild keeps the previous version online', async () => {
  const r = await repo(DOCS);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { buildSite } = await import('../src/builder.js');
  const { host, port } = await startHost({ buildFn: async (args) => { await gate; return buildSite(args); } });
  const res = await call(port, 'POST', '/__host/api/sites', { json: { slug: 'slow', repo: r.url } });
  assert.equal(res.status, 201);
  const waiting = await call(port, 'GET', '/', { host: 'slow.docs.test', auth: false });
  assert.equal(waiting.status, 503);
  assert.equal(waiting.headers['retry-after'], '15');
  release();
  await host.idle();
  assert.equal((await call(port, 'GET', '/', { host: 'slow.docs.test', auth: false })).status, 200);

  // Break the docs config. The next build fails, and the old pages stay up.
  await commit(r.root, { 'docubase.config.json': '{ "title": 5 }' }, 'break');
  await call(port, 'POST', '/__host/api/sites/slow/deploy', { json: {} });
  await host.idle();
  const state = (await call(port, 'GET', '/__host/api/sites/slow')).json.site;
  assert.equal(state.status.state, 'failed');
  assert.match(state.status.error, /"title" must be a string/);
  assert.match((await call(port, 'GET', '/', { host: 'slow.docs.test', auth: false })).text, /Hello from the hosted docs/);

  await commit(r.root, { 'docubase.config.json': '{ "title": "Fixed" }' }, 'fix');
  await call(port, 'POST', '/__host/api/sites/slow/deploy', { json: {} });
  await host.idle();
  assert.equal((await call(port, 'GET', '/__host/api/sites/slow')).json.site.status.state, 'ready');
});

test('repositories with symlinks or oversized files cannot read the server or exhaust it', async () => {
  const dir = await tmp('evil');
  await writeFiles(dir, { 'index.md': '# Evil\n\nHi.' });
  await symlink('/etc/passwd', path.join(dir, 'passwd.md'));
  const r = await repo({}, { dir });
  const { host, port } = await startHost();
  await createSite(port, host, { slug: 'evil', repo: r.url });
  const page = await call(port, 'GET', '/passwd/', { host: 'evil.docs.test', auth: false });
  assert.ok(!/root:.*:0:0/.test(page.text), 'a symlink is not followed to a file on the server');

  const big = await repo({ 'index.md': '# Big', 'blob.bin': 'x'.repeat(1.5e6) });
  const small = await startHost({ env: { DOCUBASE_MAX_DOCS_MB: '1' } });
  await createSite(small.port, small.host, { slug: 'big', repo: big.url });
  const state = (await call(small.port, 'GET', '/__host/api/sites/big')).json.site.status;
  assert.equal(state.state, 'failed');
  assert.match(state.error, /above the 1 MB limit/);
});

test('in production mode a customer config cannot point the assistant at an internal server', async () => {
  const r = await repo({
    'docubase.config.json': JSON.stringify({ assistant: { enabled: true, provider: 'openai', model: 'm', baseUrl: 'http://169.254.169.254/v1' } }),
    'index.md': '# Home',
  });
  const { host, port } = await startHost({ unsafe: { allowFileRepos: true } });
  await createSite(port, host, { slug: 'ssrf', repo: r.url });
  const state = (await call(port, 'GET', '/__host/api/sites/ssrf')).json.site.status;
  assert.equal(state.state, 'failed');
  assert.match(state.error, /assistant\.baseUrl must use https/);
});

/* ------------------------------------------------------------------------------- admin API */

test('the admin API needs the token, rejects bad input and never returns secrets', async () => {
  const r = await repo(DOCS);
  const { host, port, data } = await startHost();
  assert.equal((await call(port, 'GET', '/__host/api/sites', { auth: false })).status, 401);
  assert.equal((await call(port, 'GET', '/__host/api/sites', { headers: { authorization: 'Bearer wrong' } })).status, 401);

  const bad = [
    [{ slug: 'Bad Name', repo: r.url }, /"slug" must be/],
    [{ slug: 'admin', repo: r.url }, /reserved/],
    [{ slug: 'ok', repo: 'http://github.com/a/b' }, /must start with https/],
    [{ slug: 'ok', repo: 'https://user:pw@github.com/a/b' }, /credentials/],
    [{ slug: 'ok', repo: r.url, branch: '--upload-pack=x' }, /not a valid branch/],
    [{ slug: 'ok', repo: r.url, dir: '../etc' }, /"dir" must be a folder/],
    [{ slug: 'ok', repo: r.url, repoToken: 'short' }, /repoToken/],
    [{ repo: r.url }, /"slug" must be/],
  ];
  for (const [body, pattern] of bad) {
    const res = await call(port, 'POST', '/__host/api/sites', { json: body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.json.error, pattern);
  }
  assert.equal((await call(port, 'POST', '/__host/api/sites', { body: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await call(port, 'POST', '/__host/api/sites', { body: 'x'.repeat(20000), headers: { 'content-type': 'application/json' } })).status, 413);

  const created = await createSite(port, host, { slug: 'secret', repo: r.url, repoToken: 'ghp_privatetoken123456' });
  assert.equal(created.site.hasRepoToken, true);
  assert.equal((await call(port, 'POST', '/__host/api/sites', { json: { slug: 'secret', repo: r.url } })).status, 409);

  const everything = JSON.stringify([created, (await call(port, 'GET', '/__host/api/sites')).json]);
  assert.ok(!everything.includes('ghp_privatetoken'), 'the token is never returned');
  const stored = await readFile(path.join(data, 'sites.json'), 'utf8');
  assert.ok(!stored.includes('ghp_privatetoken'), 'the token is encrypted at rest');
  assert.ok(!stored.includes(created.webhook.secret), 'the webhook secret is encrypted at rest');
  assert.equal(((await readFile(path.join(data, 'sites.json'))).length > 0), true);

  const updated = await call(port, 'PATCH', '/__host/api/sites/secret', { json: { branch: 'main', repoToken: null } });
  assert.equal(updated.json.site.hasRepoToken, false);
  await host.idle();
  const gone = await call(port, 'DELETE', '/__host/api/sites/secret');
  assert.equal(gone.status, 200);
  assert.equal((await call(port, 'GET', '/__host/api/sites/secret')).status, 404);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(path.join(data, 'deploys')), [], 'the deleted site\'s builds are removed from disk');
});

test('repeated wrong tokens are slowed down', async () => {
  const { port } = await startHost();
  let last;
  for (let i = 0; i < 22; i += 1) last = await call(port, 'GET', '/__host/api/sites', { headers: { authorization: 'Bearer nope' } });
  assert.equal(last.status, 429);
  const right = await call(port, 'GET', '/__host/api/sites');
  assert.equal(right.status, 429, 'even the right token waits, so guessing gains nothing');
});

test('the admin API can be limited to one hostname', async () => {
  const { port } = await startHost({ env: { DOCUBASE_ADMIN_HOST: 'admin.docs.test' } });
  assert.equal((await call(port, 'GET', '/__host/api/sites', { host: 'admin.docs.test' })).status, 200);
  assert.equal((await call(port, 'GET', '/__host/api/sites', { host: 'demo.docs.test' })).status, 404, 'the API does not exist on customer hostnames');
  assert.equal((await call(port, 'GET', '/__host/tls-check?domain=admin.docs.test', { auth: false })).status, 200);
  assert.throws(() => readSettings({ DOCUBASE_ADMIN_TOKEN: TOKEN, DOCUBASE_MASTER_KEY: MASTER, DOCUBASE_BASE_DOMAIN: 'docs.test', DOCUBASE_ADMIN_HOST: 'bad host' }), /DOCUBASE_ADMIN_HOST/);
});

test('the site limit is enforced', async () => {
  const r = await repo(DOCS);
  const { host, port } = await startHost({ env: { DOCUBASE_MAX_SITES: '1' } });
  await createSite(port, host, { slug: 'one', repo: r.url });
  const second = await call(port, 'POST', '/__host/api/sites', { json: { slug: 'two', repo: r.url } });
  assert.equal(second.status, 403);
  assert.match(second.json.error, /limited to 1 sites/);
});

/* ------------------------------------------------------------------------------- webhooks */

const sign = (secret, body) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

test('a signed GitHub push rebuilds the site, and everything else is refused or ignored', async () => {
  const r = await repo(DOCS);
  const { host, port } = await startHost();
  const created = await createSite(port, host, { slug: 'hook', repo: r.url });
  const secret = created.webhook.secret;
  const url = '/__host/webhook/hook';
  const push = JSON.stringify({ ref: 'refs/heads/main' });

  const newCommit = await commit(r.root, { 'index.md': '# Welcome\n\nUpdated by a push.' });
  const ok = await call(port, 'POST', url, { auth: false, body: push, headers: { 'x-hub-signature-256': sign(secret, push), 'x-github-event': 'push' } });
  assert.equal(ok.status, 202);
  assert.equal(ok.json.queued, true);
  await host.idle();
  assert.match((await call(port, 'GET', '/', { host: 'hook.docs.test', auth: false })).text, /Updated by a push/);
  assert.equal((await call(port, 'GET', '/__host/api/sites/hook')).json.site.deploy.commit, newCommit);

  const headers = (body, extra = {}) => ({ 'x-hub-signature-256': sign(secret, body), 'x-github-event': 'push', ...extra });
  assert.equal((await call(port, 'POST', url, { auth: false, body: push, headers: { 'x-hub-signature-256': sign('wrong', push), 'x-github-event': 'push' } })).status, 401);
  assert.equal((await call(port, 'POST', url, { auth: false, body: push, headers: { 'x-github-event': 'push' } })).status, 401, 'unsigned');
  assert.equal((await call(port, 'POST', '/__host/webhook/nosuch', { auth: false, body: push, headers: headers(push) })).status, 401, 'unknown site looks the same as a bad signature');
  assert.equal((await call(port, 'GET', url, { auth: false })).status, 405);

  const other = JSON.stringify({ ref: 'refs/heads/dev' });
  const ignored = await call(port, 'POST', url, { auth: false, body: other, headers: headers(other) });
  assert.equal(ignored.status, 202);
  assert.equal(ignored.json.ignored, 'other branch');
  assert.equal((await call(port, 'POST', url, { auth: false, body: '{}', headers: headers('{}', { 'x-github-event': 'ping' }) })).status, 200);
  assert.equal((await call(port, 'POST', url, { auth: false, body: '{}', headers: headers('{}', { 'x-github-event': 'issues' }) })).json.ignored, 'event issues');

  // GitLab uses a shared token header instead of a signature.
  const gl = await call(port, 'POST', url, { auth: false, body: push, headers: { 'x-gitlab-token': secret, 'x-gitlab-event': 'Push Hook' } });
  assert.equal(gl.status, 202);
  await host.idle();
  assert.equal((await call(port, 'POST', url, { auth: false, body: push, headers: { 'x-gitlab-token': 'nope', 'x-gitlab-event': 'Push Hook' } })).status, 401);
});

/* ---------------------------------------------------------------------------------- domains */

test('custom domains route to a site, are unique, and are checked for on demand certificates', async () => {
  const r = await repo(DOCS);
  const { host, port } = await startHost();
  await createSite(port, host, { slug: 'one', repo: r.url });
  await createSite(port, host, { slug: 'two', repo: r.url });

  const set = await call(port, 'PUT', '/__host/api/sites/one/domains', { json: { domains: ['Docs.Example.com.', 'docs.example.com'] } });
  assert.deepEqual(set.json.domains, ['docs.example.com']);
  assert.match((await call(port, 'GET', '/', { host: 'docs.example.com:8443', auth: false })).text, /Hello from the hosted docs/);

  const clash = await call(port, 'PUT', '/__host/api/sites/two/domains', { json: { domains: ['docs.example.com'] } });
  assert.equal(clash.status, 409);
  for (const bad of ['not a domain', '127.0.0.1', 'x.docs.test', 'docs.test', 'localhost']) {
    assert.equal((await call(port, 'PUT', '/__host/api/sites/two/domains', { json: { domains: [bad] } })).status, 400, bad);
  }

  assert.equal((await call(port, 'GET', '/__host/tls-check?domain=docs.example.com', { auth: false })).status, 200);
  assert.equal((await call(port, 'GET', '/__host/tls-check?domain=one.docs.test', { auth: false })).status, 200);
  assert.equal((await call(port, 'GET', '/__host/tls-check?domain=evil.example.org', { auth: false })).status, 404);
  assert.equal((await call(port, 'GET', '/__host/health', { auth: false })).json.ok, true);
});

test('a site that turns on MCP gets a hosted endpoint that follows deploys', async () => {
  const r = await repo({ ...DOCS, 'docubase.config.json': JSON.stringify({ mcp: { enabled: true } }) });
  const { host, port } = await startHost();
  await createSite(port, host, { slug: 'agents', repo: r.url });
  const mcp = (json, headers = {}) => call(port, 'POST', '/__docubase/mcp', { host: 'agents.docs.test', auth: false, json, headers: { accept: 'application/json, text/event-stream', ...headers } });

  const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.serverInfo.name, 'docubase');
  const search = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_docs', arguments: { query: 'installer' } } });
  assert.match(search.json.result.content[0].text, /path: guide/);

  await commit(r.root, { 'guide.md': '---\ntitle: Guide\n---\n\n## Install\n\nRun the new zeppelin installer.' });
  await call(port, 'POST', '/__host/api/sites/agents/deploy');
  await host.idle();
  const page = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_page', arguments: { path: 'guide' } } });
  assert.match(page.json.result.content[0].text, /zeppelin/, 'the endpoint serves the newest deploy');

  // A site without MCP turned on has no endpoint.
  const plain = await repo(DOCS);
  await createSite(port, host, { slug: 'plain', repo: plain.url });
  const none = await call(port, 'POST', '/__docubase/mcp', { host: 'plain.docs.test', auth: false, json: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  assert.equal(none.status, 405);
});

/* -------------------------------------------------------------------------------- assistant */

async function mockModel() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const c of req) parts.push(c);
    requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(parts).toString('utf8')) });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ content: [{ type: 'text', text: 'Run the installer.' }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

test('each site has its own assistant key, encrypted at rest, and a customer cannot change who is rate limited', async () => {
  const model = await mockModel();
  const r = await repo({
    ...DOCS,
    'docubase.config.json': JSON.stringify({ assistant: { enabled: true, provider: 'anthropic', model: 'm', baseUrl: model.url, rateLimitPerMinute: 2, trustProxy: true } }),
  });
  const { host, port, data } = await startHost();
  await createSite(port, host, { slug: 'ask', repo: r.url });
  const ask = (headers = {}) => call(port, 'POST', '/__docubase/ask', { host: 'ask.docs.test', auth: false, json: { question: 'How do I install?' }, headers });

  const noKey = await ask();
  assert.equal(noKey.status, 503);
  assert.match(noKey.json.error, /not set up for this site/);
  assert.equal(model.requests.length, 0);

  const set = await call(port, 'PUT', '/__host/api/sites/ask/assistant-key', { json: { key: 'sk-customer-secret-1' } });
  assert.deepEqual(set.json, { hasAssistantKey: true });
  assert.equal((await call(port, 'GET', '/__host/api/sites/ask/assistant-key')).status, 405, 'keys cannot be read back');
  assert.equal((await call(port, 'GET', '/__host/api/sites/ask')).json.site.hasAssistantKey, true);
  assert.ok(!(await readFile(path.join(data, 'sites.json'), 'utf8')).includes('sk-customer-secret'));

  const answered = await ask({ 'x-forwarded-for': '10.0.0.1' });
  assert.equal(answered.status, 200);
  assert.match(answered.json.answer, /Run the installer/);
  assert.equal(model.requests[0].headers['x-api-key'], 'sk-customer-secret-1');

  await ask({ 'x-forwarded-for': '10.0.0.2' });
  const limited = await ask({ 'x-forwarded-for': '10.0.0.3' });
  assert.equal(limited.status, 429, 'changing X-Forwarded-For does not get around the limit');

  // Removing the key switches the assistant off again.
  await call(port, 'DELETE', '/__host/api/sites/ask/assistant-key');
  assert.equal((await call(port, 'GET', '/__host/api/sites/ask')).json.site.hasAssistantKey, false);
});

test('the assistant key and the stored site survive a restart', async () => {
  const model = await mockModel();
  const r = await repo({ ...DOCS, 'docubase.config.json': JSON.stringify({ assistant: { enabled: true, provider: 'anthropic', model: 'm', baseUrl: model.url } }) });
  const first = await startHost();
  await createSite(first.port, first.host, { slug: 'again', repo: r.url });
  await call(first.port, 'PUT', '/__host/api/sites/again/assistant-key', { json: { key: 'sk-persisted-key-1' } });
  await first.host.close();

  const second = await startHost({ dataDir: first.data });
  assert.match((await call(second.port, 'GET', '/', { host: 'again.docs.test', auth: false })).text, /Hello from the hosted docs/);
  const res = await call(second.port, 'POST', '/__docubase/ask', { host: 'again.docs.test', auth: false, json: { question: 'install the installer' } });
  assert.equal(res.status, 200);
  assert.equal(model.requests.at(-1).headers['x-api-key'], 'sk-persisted-key-1');

  // A different master key cannot read the stored secrets.
  const wrong = await startHost({ dataDir: first.data, env: { DOCUBASE_MASTER_KEY: 'f'.repeat(64) } });
  const broken = await call(wrong.port, 'POST', '/__docubase/ask', { host: 'again.docs.test', auth: false, json: { question: 'install the installer' } });
  assert.equal(broken.status, 500);
  assert.ok(!broken.text.includes('sk-persisted'));
});

/* ------------------------------------------------------------------------------ building blocks */

test('settings explain what is missing', () => {
  const ok = { DOCUBASE_ADMIN_TOKEN: TOKEN, DOCUBASE_MASTER_KEY: MASTER, DOCUBASE_BASE_DOMAIN: 'docs.example.com' };
  assert.equal(readSettings(ok).baseDomain, 'docs.example.com');
  assert.throws(() => readSettings({ ...ok, DOCUBASE_ADMIN_TOKEN: 'short' }), (e) => e instanceof SettingsError && /at least 24/.test(e.message));
  assert.throws(() => readSettings({ ...ok, DOCUBASE_MASTER_KEY: '' }), /DOCUBASE_MASTER_KEY: is required/);
  assert.throws(() => readSettings({ ...ok, DOCUBASE_MASTER_KEY: 'abcd' }), /32 bytes/);
  assert.throws(() => readSettings({ ...ok, DOCUBASE_BASE_DOMAIN: '' }), /DOCUBASE_BASE_DOMAIN is required/);
  assert.throws(() => readSettings({ ...ok, DOCUBASE_BASE_DOMAIN: 'a b' }), /DOCUBASE_BASE_DOMAIN/);
  assert.throws(() => readSettings({ ...ok, DOCUBASE_MAX_SITES: '0' }), /DOCUBASE_MAX_SITES must be/);
  assert.equal(readSettings(ok).allowFileRepos, false);
});

test('secrets are encrypted per site and purpose, and tampering is detected', () => {
  const key = parseMasterKey(MASTER);
  const sealed = seal(key, 'site:a:assistant', 'sk-secret');
  assert.ok(!sealed.includes('sk-secret'));
  assert.equal(open(key, 'site:a:assistant', sealed), 'sk-secret');
  assert.throws(() => open(key, 'site:b:assistant', sealed), 'a value copied to another site does not decrypt');
  assert.throws(() => open(key, 'site:a:repo', sealed), 'nor does one used for another purpose');
  assert.throws(() => open(key, 'site:a:assistant', sealed.slice(0, -2) + 'AA'), 'a changed value is rejected');
  assert.notEqual(seal(key, 'c', 'same'), seal(key, 'c', 'same'), 'every encryption uses a fresh nonce');
  assert.equal(verifyGithubSignature('s', Buffer.from('b'), sign('s', 'b')), true);
  assert.equal(verifyGithubSignature('s', Buffer.from('b'), 'sha256=zz'), false);
});

test('repository, branch and folder checks', () => {
  assert.equal(parseRepoUrl('https://github.com/acme/docs').hostname, 'github.com');
  for (const bad of ['git@github.com:a/b.git', 'ssh://github.com/a/b', 'http://github.com/a/b', 'https://u:p@github.com/a/b', 'https://github.com/a/b?x=1', 'file:///tmp/x', 'not a url', 'https://github.com/']) {
    assert.throws(() => parseRepoUrl(bad), bad);
  }
  assert.equal(parseRepoUrl('file:///tmp/x', { allowFile: true }).protocol, 'file:');
  for (const bad of ['-x', '--upload-pack=y', 'a..b', 'a/', 'x.lock', '', 'a b']) assert.throws(() => checkBranch(bad), bad);
  assert.equal(checkBranch('feature/docs-1'), 'feature/docs-1');
  assert.equal(checkDocsDir('/docs/'), 'docs');
  assert.equal(checkDocsDir(''), '');
  for (const bad of ['../x', 'a/../b', '.git/config', 'a//b', 'a b', '/etc/../x']) assert.throws(() => checkDocsDir(bad), bad);
});

test('the network guard refuses private and unresolvable addresses', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '224.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);

  await assert.rejects(assertPublicHost('localhost'), /not a public host/);
  await assert.rejects(assertPublicHost('metadata.internal'), /not a public host/);
  await assert.rejects(assertPublicHost('169.254.169.254'), /not a public address/);
  await assert.rejects(assertPublicHost('rebind.example.com', async () => [{ address: '8.8.8.8' }, { address: '10.0.0.5' }]), /does not point to a public address/);
  await assert.rejects(assertPublicHost('nxdomain.example.com', async () => { throw new Error('ENOTFOUND'); }), /could not be resolved/);
  await assert.doesNotReject(assertPublicHost('good.example.com', async () => [{ address: '93.184.216.34' }]));

  let called = 0;
  const fetchImpl = async () => { called += 1; return new Response('ok'); };
  const guarded = guardedFetch(fetchImpl, { lookup: async () => [{ address: '93.184.216.34' }] });
  assert.equal(await (await guarded('https://good.example.com/x')).text(), 'ok');
  await assert.rejects(guarded('http://good.example.com/x'), /Only https/);
  await assert.rejects(guardedFetch(fetchImpl, { lookup: async () => [{ address: '10.0.0.1' }] })('https://internal.example.com/x'), /public address/);
  assert.equal(called, 1);
});

test('addresses that wrap an IPv4 address are judged by the address inside', () => {
  for (const ip of ['::ffff:7f00:1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '::7f00:1', '64:ff9b::a00:1', '2002:7f00:1::', '2002:a9fe:a9fe::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '::ffff:c0a8:1', 'fe80::1%eth0', 'ff02::1', '::']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['::ffff:808:808', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('the clone refuses to follow redirects, so a repository host cannot bounce it to an internal address', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/git.js', import.meta.url), 'utf8');
  assert.match(source, /http\.followRedirects=false/);
});
