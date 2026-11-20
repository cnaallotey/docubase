import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHost, readSettings } from '../src/index.js';
import { formEncode, verifyStripeSignature } from '../src/billing.js';
import { verifyPaystackSignature } from '../src/paystack.js';
import { hashPassword, verifyPassword } from '../src/accounts.js';

const TOKEN = 'admin-token-for-tests-0123456789';
const MASTER = '0'.repeat(32) + 'b'.repeat(32);
const STRIPE = { DOCUBASE_BILLING: 'stripe', STRIPE_SECRET_KEY: 'sk_test_abcdefghijklmnop', STRIPE_PRICE_ID: 'price_TESTPRO123', STRIPE_WEBHOOK_SECRET: 'whsec_testsecret1234567890' };
const PAYSTACK = { PAYSTACK_SECRET_KEY: 'sk_test_0123456789abcdef0123456789abcdef01234567', PAYSTACK_PLAN_CODE: 'PLN_docubasepro' };
const APP = 'app.docs.test';
const cleanup = [];
after(async () => { for (const fn of cleanup.reverse()) await fn().catch(() => {}); });
const quiet = { log() {}, warn() {}, error() {} };

async function tmp(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), `docubase-dash-${prefix}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function repo(files = { 'index.md': '# Hello\n\nHosted.' }) {
  const root = await tmp('repo');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return `file://${root}`;
}

/** A stand in for the Paystack API: a plan, transaction initialize and the manage subscription link. */
async function fakePaystack() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const text = Buffer.concat(parts).toString('utf8');
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: text ? JSON.parse(text) : null });
    let data = {};
    if (req.url.startsWith('/plan/')) data = { plan_code: 'PLN_docubasepro', amount: 1200, currency: 'USD', interval: 'monthly' };
    else if (req.url === '/transaction/initialize') data = { authorization_url: 'https://checkout.paystack.com/test_access_1', access_code: 'test_access_1', reference: 'ref_1' };
    else if (req.url.endsWith('/manage/link')) data = { link: 'https://paystack.com/manage/subscriptions/SUB_1?subscription_token=t' };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: true, message: 'ok', data }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return { requests, api: `http://127.0.0.1:${server.address().port}` };
}

function paystackEvent(event, secret = PAYSTACK.PAYSTACK_SECRET_KEY) {
  const body = JSON.stringify(event);
  return { body, header: createHmac('sha512', secret).update(body).digest('hex'), headerName: 'x-paystack-signature', path: '/__host/billing/webhook' };
}

/** A stand in for the Stripe API that records requests and answers like Stripe would. */
async function fakeStripe() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const body = Object.fromEntries(new URLSearchParams(Buffer.concat(parts).toString('utf8')));
    requests.push({ url: req.url, headers: req.headers, body });
    const url = req.url.includes('checkout') ? 'https://checkout.stripe.com/c/pay/cs_test_1' : 'https://billing.stripe.com/p/session/test_1';
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'cs_test_1', url }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return { requests, api: `http://127.0.0.1:${server.address().port}/v1` };
}

async function startHost(env = {}, unsafe = {}) {
  const settings = readSettings({
    DOCUBASE_ADMIN_TOKEN: TOKEN,
    DOCUBASE_MASTER_KEY: MASTER,
    DOCUBASE_BASE_DOMAIN: 'docs.test',
    DOCUBASE_DATA_DIR: await tmp('data'),
    PORT: '0',
    ...env,
  });
  const host = createHost({ settings, log: quiet, unsafeForTests: { allowFileRepos: true, ...unsafe } });
  const { port } = await host.start();
  cleanup.push(() => host.close());
  return { host, port };
}

/** A tiny browser: keeps the session cookie and sends the header the dashboard requires. */
function client(port, { hostName = APP } = {}) {
  let cookie = null;
  const send = (method, pathName, { json, headers = {}, csrf = true } = {}) => new Promise((resolve, reject) => {
    const payload = json !== undefined ? JSON.stringify(json) : undefined;
    const req = httpRequest({ host: '127.0.0.1', port, method, path: pathName, headers: {
      host: hostName,
      ...(cookie ? { cookie } : {}),
      ...(csrf && method !== 'GET' ? { 'x-docubase': '1' } : {}),
      ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      ...headers,
    } }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => {
        const set = res.headers['set-cookie'];
        if (set) {
          const first = set[0].split(';')[0];
          cookie = first.endsWith('=') ? null : first;
        }
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
  return { send, get cookie() { return cookie; } };
}

function admin(port, method, pathName, json) {
  return client(port, { hostName: 'admin.docs.test' }).send(method, pathName, { json, headers: { authorization: `Bearer ${TOKEN}` }, csrf: false });
}

function signedEvent(event, secret = STRIPE.STRIPE_WEBHOOK_SECRET, at = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(event);
  const sig = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
  return { body, header: `t=${at},v1=${sig}` };
}

function postWebhook(port, { body, header, headerName = 'stripe-signature', path: pathName = '/__host/stripe/webhook' }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: pathName, headers: { host: APP, 'content-type': 'application/json', [headerName]: header, 'content-length': Buffer.byteLength(body) } }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/* ------------------------------------------------------------------------------ accounts */

test('passwords are hashed with scrypt and checked in constant time', async () => {
  const stored = await hashPassword('correct horse battery');
  assert.match(stored, /^scrypt\$16384\$8\$1\$/);
  assert.ok(!stored.includes('correct horse'));
  assert.equal(await verifyPassword('correct horse battery', stored), true);
  assert.equal(await verifyPassword('wrong horse battery', stored), false);
  assert.equal(await verifyPassword('anything', 'garbage'), false);
});

test('sign up is closed by default, the admin creates accounts, and sessions are safe cookies', async () => {
  const { host, port } = await startHost();
  const browser = client(port);
  assert.equal((await browser.send('POST', '/api/signup', { json: { email: 'a@example.com', password: 'long enough password' } })).status, 403);

  const made = await admin(port, 'POST', '/__host/api/users', { email: 'Ana@Example.com', password: 'long enough password' });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.user.email, 'ana@example.com');
  assert.equal(JSON.stringify(made.json).includes('scrypt'), false, 'the password hash is never returned');
  assert.equal((await admin(port, 'POST', '/__host/api/users', { email: 'ana@example.com', password: 'another long one' })).status, 409);
  assert.equal((await admin(port, 'POST', '/__host/api/users', { email: 'not-an-email', password: 'long enough password' })).status, 400);

  assert.equal((await browser.send('POST', '/api/session', { json: { email: 'ana@example.com', password: 'wrong password!!' } })).status, 401);
  assert.equal((await browser.send('POST', '/api/session', { json: { email: 'ana@example.com', password: 'long enough password' }, csrf: false })).status, 403, 'changes need the x-docubase header');

  const login = await browser.send('POST', '/api/session', { json: { email: 'ana@example.com', password: 'long enough password' } });
  assert.equal(login.status, 200, login.text);
  const cookie = login.headers['set-cookie'][0];
  assert.match(cookie, /^docubase_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  assert.equal(login.json.user.email, 'ana@example.com');

  const stored = JSON.parse(await readFile(path.join(host.settings.dataDir, 'sites.json'), 'utf8'));
  const token = browser.cookie.split('=')[1];
  assert.ok(!JSON.stringify(stored).includes(token), 'only a hash of the session token is stored');

  assert.equal((await browser.send('GET', '/api/session')).json.user.email, 'ana@example.com');
  assert.equal((await browser.send('DELETE', '/api/session')).status, 200);
  assert.equal((await browser.send('GET', '/api/session')).json.user, null);
  assert.equal((await browser.send('GET', '/api/sites')).status, 401);
});

test('repeated wrong passwords are slowed down', async () => {
  const { port } = await startHost();
  await admin(port, 'POST', '/__host/api/users', { email: 'b@example.com', password: 'long enough password' });
  const browser = client(port);
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) {
    const res = await browser.send('POST', '/api/session', { json: { email: 'b@example.com', password: `wrong guess ${i}` } });
    limited = res.status === 429;
  }
  assert.ok(limited);
});

test('with open sign up each user sees and changes only their own sites, within their cap', async () => {
  const { host, port } = await startHost({ DOCUBASE_SIGNUP: 'open', DOCUBASE_USER_MAX_SITES: '1' });
  const url = await repo();
  const ana = client(port);
  const ben = client(port);
  assert.equal((await ana.send('POST', '/api/signup', { json: { email: 'ana@example.com', password: 'short' } })).status, 400);
  assert.equal((await ana.send('POST', '/api/signup', { json: { email: 'ana@example.com', password: 'ana long password' } })).status, 201);
  assert.equal((await ben.send('POST', '/api/signup', { json: { email: 'ben@example.com', password: 'ben long password' } })).status, 201);

  const created = await ana.send('POST', '/api/sites', { json: { slug: 'ana-docs', repo: url } });
  assert.equal(created.status, 201, created.text);
  assert.ok(created.json.webhook.secret.length >= 30, 'the webhook secret is shown once at creation');
  await host.idle();
  assert.equal((await ana.send('GET', '/api/sites/ana-docs')).json.site.status.state, 'ready');
  assert.equal((await ana.send('POST', '/api/sites', { json: { slug: 'ana-two', repo: url } })).status, 403, 'the per user cap applies');

  assert.deepEqual((await ben.send('GET', '/api/sites')).json.sites, []);
  for (const [method, p, json] of [['GET', '/api/sites/ana-docs'], ['PATCH', '/api/sites/ana-docs', { branch: 'x' }], ['DELETE', '/api/sites/ana-docs'], ['POST', '/api/sites/ana-docs/deploy'], ['PUT', '/api/sites/ana-docs/assistant-key', { key: 'sk-stolen-key-1' }]]) {
    assert.equal((await ben.send(method, p, { json })).status, 404, `${method} ${p} is hidden from other users`);
  }
  assert.equal((await ben.send('POST', '/api/sites', { json: { slug: 'ana-docs', repo: url } })).status, 409);

  // The admin API still sees every site, and can delete a user with their sites.
  assert.equal((await admin(port, 'GET', '/__host/api/sites')).json.sites.length, 1);
  const users = (await admin(port, 'GET', '/__host/api/users')).json.users;
  const anaId = users.find((u) => u.email === 'ana@example.com').id;
  assert.deepEqual(users.find((u) => u.id === anaId).sites, ['ana-docs']);
  assert.equal((await admin(port, 'DELETE', `/__host/api/users/${anaId}`)).status, 200);
  assert.equal((await admin(port, 'GET', '/__host/api/sites')).json.sites.length, 0);
  assert.equal((await ana.send('GET', '/api/session')).json.user, null, 'their sessions end too');
});

test('changing the password signs out other devices, and deleting the account removes its sites', async () => {
  const { host, port } = await startHost({ DOCUBASE_SIGNUP: 'open' });
  const laptop = client(port);
  const phone = client(port);
  await laptop.send('POST', '/api/signup', { json: { email: 'cy@example.com', password: 'first long password' } });
  await phone.send('POST', '/api/session', { json: { email: 'cy@example.com', password: 'first long password' } });
  assert.equal((await laptop.send('POST', '/api/account/password', { json: { current: 'nope nope nope', next: 'second long password' } })).status, 401);
  assert.equal((await laptop.send('POST', '/api/account/password', { json: { current: 'first long password', next: 'second long password' } })).status, 200);
  assert.ok((await laptop.send('GET', '/api/session')).json.user, 'this device stays signed in');
  assert.equal((await phone.send('GET', '/api/session')).json.user, null, 'the other device is signed out');

  await laptop.send('POST', '/api/sites', { json: { slug: 'cy-docs', repo: await repo() } });
  await host.idle();
  assert.equal((await laptop.send('DELETE', '/api/account', { json: { password: 'first long password' } })).status, 401);
  assert.equal((await laptop.send('DELETE', '/api/account', { json: { password: 'second long password' } })).status, 200);
  assert.equal(host.store.get('cy-docs'), null);
  assert.equal((await laptop.send('POST', '/api/session', { json: { email: 'cy@example.com', password: 'second long password' } })).status, 401);
});

test('the dashboard page is served with a strict content security policy', async () => {
  const { port } = await startHost();
  const browser = client(port);
  const page = await browser.send('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.ok(!/<script>/.test(page.text) && !/ on\w+=/.test(page.text), 'no inline script');
  assert.equal((await browser.send('GET', '/app.js')).status, 200);
  assert.equal((await browser.send('GET', '/app.css')).status, 200);
  assert.match(page.headers['content-security-policy'], /font-src 'self'/);
  const font = await browser.send('GET', '/fonts/eb-garamond-latin-400-normal.woff2');
  assert.equal(font.status, 200);
  assert.equal(font.headers['content-type'], 'font/woff2');
  assert.equal((await browser.send('GET', '/fonts/../../package.json')).status, 404);
  assert.equal((await browser.send('GET', '/fonts/other.woff2')).status, 404);
  assert.equal((await browser.send('GET', '/../src/host.js')).status, 404);
  assert.equal((await browser.send('GET', '/sites.json')).status, 404);

  const off = await startHost({ DOCUBASE_DASHBOARD_HOST: 'off' });
  assert.equal((await client(off.port).send('GET', '/')).status, 404, 'with the dashboard off, the name is just an unknown site');
});

/* ------------------------------------------------------------------------------- billing */

test('Stripe settings must come as a set and look right', () => {
  const base = { DOCUBASE_ADMIN_TOKEN: TOKEN, DOCUBASE_MASTER_KEY: MASTER, DOCUBASE_BASE_DOMAIN: 'docs.test' };
  assert.throws(() => readSettings({ ...base, STRIPE_SECRET_KEY: STRIPE.STRIPE_SECRET_KEY }), /all three/);
  assert.throws(() => readSettings({ ...base, ...STRIPE, STRIPE_SECRET_KEY: 'pk_test_abcdefghijklmnop' }), /secret key/);
  assert.throws(() => readSettings({ ...base, DOCUBASE_SIGNUP: 'maybe' }), /open or closed/);
  assert.equal(readSettings({ ...base, ...STRIPE }).billing.stripe.priceId, 'price_TESTPRO123');
  assert.equal(readSettings({ ...base, ...STRIPE }).billing.provider, 'stripe');
});

test('Paystack is the default provider and Stripe stays off until it is chosen', () => {
  const base = { DOCUBASE_ADMIN_TOKEN: TOKEN, DOCUBASE_MASTER_KEY: MASTER, DOCUBASE_BASE_DOMAIN: 'docs.test' };
  const { DOCUBASE_BILLING, ...stripeKeys } = STRIPE;
  assert.equal(readSettings({ ...base, ...PAYSTACK }).billing.provider, 'paystack');
  assert.equal(readSettings({ ...base, ...stripeKeys }).billing.provider, null, 'Stripe keys alone do not turn billing on');
  assert.equal(readSettings({ ...base, ...PAYSTACK, ...stripeKeys }).billing.provider, 'paystack', 'Stripe keys can wait beside Paystack');
  assert.equal(readSettings({ ...base, ...PAYSTACK, ...STRIPE }).billing.provider, 'stripe');
  assert.equal(readSettings({ ...base, ...PAYSTACK, DOCUBASE_BILLING: 'off' }).billing.provider, null);
  assert.throws(() => readSettings({ ...base, PAYSTACK_SECRET_KEY: PAYSTACK.PAYSTACK_SECRET_KEY }), /Set both/);
  assert.throws(() => readSettings({ ...base, ...PAYSTACK, PAYSTACK_SECRET_KEY: 'pk_test_0123456789abcdef0123456789' }), /Paystack secret key/);
  assert.throws(() => readSettings({ ...base, ...PAYSTACK, PAYSTACK_PLAN_CODE: 'plan-1' }), /PLN_/);
  assert.throws(() => readSettings({ ...base, DOCUBASE_BILLING: 'stripe' }), /needs STRIPE_SECRET_KEY/);
  assert.throws(() => readSettings({ ...base, DOCUBASE_BILLING: 'paypal' }), /paystack, stripe or off/);
});

test('Paystack webhook signatures are checked', () => {
  const { body, header } = paystackEvent({ event: 'ping' });
  assert.equal(verifyPaystackSignature(PAYSTACK.PAYSTACK_SECRET_KEY, Buffer.from(body), header), true);
  assert.equal(verifyPaystackSignature('sk_test_other', Buffer.from(body), header), false);
  assert.equal(verifyPaystackSignature(PAYSTACK.PAYSTACK_SECRET_KEY, Buffer.from(body + ' '), header), false, 'a changed body fails');
  assert.equal(verifyPaystackSignature(PAYSTACK.PAYSTACK_SECRET_KEY, Buffer.from(body), 'abc'), false);
});

test('Paystack: checkout opens Paystack, webhooks move the plan, and the manage link works', async () => {
  const paystack = await fakePaystack();
  const { port } = await startHost({ DOCUBASE_SIGNUP: 'open', DOCUBASE_FREE_SITES: '1', ...PAYSTACK }, { paystackApi: paystack.api });
  const kim = client(port);
  const signed = await kim.send('POST', '/api/signup', { json: { email: 'kim@example.com', password: 'kim long password' } });
  assert.equal(signed.json.limits.plan, 'free');
  assert.deepEqual(signed.json.billing, { enabled: true, provider: 'Paystack' });
  const userId = signed.json.user.id;

  const checkout = await kim.send('POST', '/api/billing/checkout');
  assert.equal(checkout.status, 200, checkout.text);
  assert.equal(checkout.json.url, 'https://checkout.paystack.com/test_access_1');
  assert.equal(paystack.requests[0].url, '/plan/PLN_docubasepro');
  const init = paystack.requests[1];
  assert.equal(init.url, '/transaction/initialize');
  assert.equal(init.headers.authorization, `Bearer ${PAYSTACK.PAYSTACK_SECRET_KEY}`);
  assert.deepEqual({ email: init.body.email, amount: init.body.amount, currency: init.body.currency, plan: init.body.plan }, { email: 'kim@example.com', amount: 1200, currency: 'USD', plan: 'PLN_docubasepro' });
  assert.equal(init.body.metadata.docubase_user, userId);
  assert.match(init.body.callback_url, /^https:\/\/app\.docs\.test\/#\/billing\?done=1$/);
  assert.match(init.body.metadata.cancel_action, /#\/billing$/);

  // Forged, or signed with a Stripe style header only: nothing changes.
  const charge = { event: 'charge.success', data: { status: 'success', metadata: { docubase_user: userId }, plan: { plan_code: 'PLN_docubasepro' }, customer: { customer_code: 'CUS_kim' } } };
  assert.equal((await postWebhook(port, paystackEvent(charge, 'sk_test_attacker'))).status, 400);
  assert.equal((await dee(kim)).limits.plan, 'free');

  // Another plan on the same Paystack account is ignored.
  assert.match((await postWebhook(port, paystackEvent({ ...charge, data: { ...charge.data, plan: { plan_code: 'PLN_other' } } }))).text, /ignored/);

  assert.equal((await postWebhook(port, paystackEvent(charge))).status, 200);
  assert.equal((await dee(kim)).limits.plan, 'pro');
  assert.equal((await kim.send('POST', '/api/billing/portal')).status, 400, 'no subscription code yet');

  const created = { event: 'subscription.create', data: { subscription_code: 'SUB_1', status: 'active', plan: { plan_code: 'PLN_docubasepro' }, customer: { customer_code: 'CUS_kim' } } };
  assert.equal((await postWebhook(port, paystackEvent(created))).status, 200);
  const portal = await kim.send('POST', '/api/billing/portal');
  assert.equal(portal.json.url, 'https://paystack.com/manage/subscriptions/SUB_1?subscription_token=t');
  assert.equal(paystack.requests.at(-1).url, '/subscription/SUB_1/manage/link');
  assert.equal((await kim.send('POST', '/api/billing/checkout')).status, 409, 'already on the paid plan');

  // Turning off renewal keeps Pro until the period ends; then the disable event moves it back to free.
  const notRenew = { event: 'subscription.not_renew', data: { ...created.data, status: 'non-renewing' } };
  assert.equal((await postWebhook(port, paystackEvent(notRenew))).status, 200);
  assert.equal((await dee(kim)).limits.plan, 'pro');
  assert.equal((await kim.send('DELETE', '/api/account', { json: { password: 'kim long password' } })).status, 409);
  const disabled = { event: 'subscription.disable', data: { ...created.data, status: 'complete' } };
  assert.equal((await postWebhook(port, paystackEvent(disabled))).status, 200);
  const after = await dee(kim);
  assert.equal(after.limits.plan, 'free');
  assert.equal(after.user.subscription, 'complete');

  // The Stripe path still answers, but only to Paystack signed events while Paystack is the provider.
  assert.equal((await postWebhook(port, { ...paystackEvent(created), path: '/__host/stripe/webhook' })).status, 200);
  assert.equal((await postWebhook(port, signedEvent({ type: 'checkout.session.completed', data: { object: {} } }))).status, 400);
});

async function dee(c) {
  return (await c.send('GET', '/api/session')).json;
}

test('Stripe webhook signatures are checked, including their age', () => {
  const { body, header } = signedEvent({ type: 'ping' });
  assert.equal(verifyStripeSignature(STRIPE.STRIPE_WEBHOOK_SECRET, Buffer.from(body), header), true);
  assert.equal(verifyStripeSignature('whsec_other', Buffer.from(body), header), false);
  assert.equal(verifyStripeSignature(STRIPE.STRIPE_WEBHOOK_SECRET, Buffer.from(body + ' '), header), false, 'a changed body fails');
  const old = signedEvent({ type: 'ping' }, STRIPE.STRIPE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600);
  assert.equal(verifyStripeSignature(STRIPE.STRIPE_WEBHOOK_SECRET, Buffer.from(old.body), old.header), false, 'an old event cannot be replayed');
  assert.equal(formEncode({ line_items: [{ price: 'p', quantity: 1 }], a: 'x y' }), 'line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&a=x%20y');
});

test('plans: free users are limited, checkout goes to Stripe, and webhooks move the plan both ways', async () => {
  const stripe = await fakeStripe();
  const txt = new Map();
  const { host, port } = await startHost({ DOCUBASE_SIGNUP: 'open', DOCUBASE_FREE_SITES: '1', ...STRIPE }, { stripeApi: stripe.api, resolveTxt: async (name) => (txt.has(name) ? [[txt.get(name)]] : Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }))) });
  const url = await repo({ 'index.md': '# Hi\n\nPaid docs.', 'docubase.config.json': JSON.stringify({ assistant: { enabled: true, provider: 'anthropic', model: 'm' } }) });
  const dee = client(port);
  const signed = await dee.send('POST', '/api/signup', { json: { email: 'dee@example.com', password: 'dee long password' } });
  assert.equal(signed.json.limits.plan, 'free');
  assert.equal(signed.json.billing.enabled, true);
  const userId = signed.json.user.id;

  assert.equal((await dee.send('POST', '/api/sites', { json: { slug: 'dee', repo: url } })).status, 201);
  await host.idle();
  assert.equal((await dee.send('POST', '/api/sites', { json: { slug: 'dee-two', repo: url } })).status, 403, 'one site on the free plan');
  assert.equal((await dee.send('PUT', '/api/sites/dee/domains', { json: { domains: ['docs.dee.example'] } })).status, 403);
  assert.equal((await dee.send('PUT', '/api/sites/dee/assistant-key', { json: { key: 'sk-dee-model-key' } })).status, 403);
  assert.equal((await dee.send('POST', '/api/billing/portal')).status, 400, 'nothing to manage before subscribing');

  const checkout = await dee.send('POST', '/api/billing/checkout');
  assert.equal(checkout.status, 200, checkout.text);
  assert.equal(checkout.json.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  const sent = stripe.requests[0];
  assert.equal(sent.url, '/v1/checkout/sessions');
  assert.equal(sent.headers.authorization, `Bearer ${STRIPE.STRIPE_SECRET_KEY}`);
  assert.equal(sent.body.mode, 'subscription');
  assert.equal(sent.body['line_items[0][price]'], 'price_TESTPRO123');
  assert.equal(sent.body.client_reference_id, userId);
  assert.equal(sent.body.customer_email, 'dee@example.com');
  assert.match(sent.body.success_url, /^https:\/\/app\.docs\.test\/#\/billing\?done=1$/);

  // A forged event changes nothing.
  const forged = signedEvent({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: userId, customer: 'cus_1', subscription: 'sub_1' } } }, 'whsec_attacker_secret_123');
  assert.equal((await postWebhook(port, forged)).status, 400);
  assert.equal((await dee.send('GET', '/api/session')).json.limits.plan, 'free');

  const paid = signedEvent({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: userId, customer: 'cus_1', subscription: 'sub_1' } } });
  assert.equal((await postWebhook(port, paid)).status, 200);
  const pro = (await dee.send('GET', '/api/session')).json;
  assert.equal(pro.limits.plan, 'pro');
  assert.equal(pro.user.subscription, 'active');

  const requested = await dee.send('PUT', '/api/sites/dee/domains', { json: { domains: ['docs.dee.example'] } });
  assert.equal(requested.status, 200);
  assert.deepEqual(requested.json.site.domains, [], 'a new domain waits for proof of ownership');
  const challenge = requested.json.site.pendingDomains[0];
  assert.equal(challenge.record, '_docubase-challenge.docs.dee.example');
  assert.match(challenge.value, /^docubase-verify=[0-9a-f]{32}$/);
  assert.equal((await client(port, { hostName: 'docs.dee.example' }).send('GET', '/')).status, 404, 'an unverified domain does not serve');

  txt.set(challenge.record, 'docubase-verify=wrong');
  assert.equal((await dee.send('POST', '/api/sites/dee/verify-domains')).json.results[0].verified, false);
  txt.set(challenge.record, challenge.value);
  const verified = await dee.send('POST', '/api/sites/dee/verify-domains');
  assert.equal(verified.json.results[0].verified, true);
  assert.deepEqual(verified.json.site.domains, ['docs.dee.example']);
  assert.deepEqual(verified.json.site.pendingDomains, []);

  assert.equal((await dee.send('PUT', '/api/sites/dee/assistant-key', { json: { key: 'sk-dee-model-key' } })).status, 200);
  const viaDomain = await client(port, { hostName: 'docs.dee.example' }).send('GET', '/');
  assert.match(viaDomain.text, /Paid docs/);
  assert.equal((await dee.send('POST', '/api/billing/portal')).json.url, 'https://billing.stripe.com/p/session/test_1');
  assert.equal(stripe.requests[1].body.customer, 'cus_1');
  assert.equal((await dee.send('DELETE', '/api/account', { json: { password: 'dee long password' } })).status, 409, 'cancel before deleting');

  // Cancelling moves the user back to free: the custom domain stops answering and the assistant key is ignored.
  const ended = signedEvent({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled' } } });
  assert.equal((await postWebhook(port, ended)).status, 200);
  assert.equal((await dee.send('GET', '/api/session')).json.limits.plan, 'free');
  assert.equal((await client(port, { hostName: 'docs.dee.example' }).send('GET', '/')).status, 404);
  const ask = await client(port, { hostName: 'dee.docs.test' }).send('POST', '/__docubase/ask', { json: { question: 'paid docs' }, csrf: false });
  assert.equal(ask.status, 503, 'the saved key is not used on the free plan');
  assert.match((await client(port, { hostName: 'dee.docs.test' }).send('GET', '/')).text, /Paid docs/, 'the site itself stays online');

  // An admin can grant a plan by hand.
  assert.equal((await admin(port, 'PATCH', `/__host/api/users/${userId}`, { plan: 'pro' })).status, 200);
  assert.equal((await dee.send('GET', '/api/session')).json.limits.plan, 'pro');
});

test('without a payment provider there are no plans and billing routes are off', async () => {
  const { port } = await startHost({ DOCUBASE_SIGNUP: 'open' });
  const eve = client(port);
  const signed = await eve.send('POST', '/api/signup', { json: { email: 'eve@example.com', password: 'eve long password' } });
  assert.deepEqual(signed.json.limits, { plan: 'none', maxSites: 3, customDomains: true, assistant: true });
  assert.equal((await eve.send('POST', '/api/billing/checkout')).status, 404);
  assert.equal((await postWebhook(port, signedEvent({ type: 'ping' }))).status, 404);
});

test('a domain verified by one site cannot be taken by another, even with its own record', async () => {
  const txt = new Map();
  const { host, port } = await startHost({ DOCUBASE_SIGNUP: 'open' }, { resolveTxt: async (name) => [[txt.get(name) || '']] });
  const url = await repo();
  const fay = client(port);
  const gus = client(port);
  await fay.send('POST', '/api/signup', { json: { email: 'fay@example.com', password: 'fay long password' } });
  await gus.send('POST', '/api/signup', { json: { email: 'gus@example.com', password: 'gus long password' } });
  await fay.send('POST', '/api/sites', { json: { slug: 'fay', repo: url } });
  await gus.send('POST', '/api/sites', { json: { slug: 'gus', repo: url } });
  await host.idle();

  const fayChallenge = (await fay.send('PUT', '/api/sites/fay/domains', { json: { domains: ['shared.example'] } })).json.site.pendingDomains[0];
  const gusChallenge = (await gus.send('PUT', '/api/sites/gus/domains', { json: { domains: ['shared.example'] } })).json.site.pendingDomains[0];
  assert.notEqual(fayChallenge.value, gusChallenge.value, 'each claim has its own token');
  txt.set(fayChallenge.record, fayChallenge.value);
  assert.equal((await fay.send('POST', '/api/sites/fay/verify-domains')).json.results[0].verified, true);
  txt.set(gusChallenge.record, gusChallenge.value);
  const second = (await gus.send('POST', '/api/sites/gus/verify-domains')).json.results[0];
  assert.equal(second.verified, false);
  assert.match(second.error, /another site/);
});
