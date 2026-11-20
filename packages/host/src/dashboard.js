import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AccountError,
  checkPassword,
  clearedCookie,
  createLimiter,
  decoyHash,
  hashPassword,
  newSessionToken,
  normalizeEmail,
  publicUser,
  readCookie,
  SESSION_COOKIE,
  SESSION_DAYS,
  sessionCookie,
  tokenId,
  verifyPassword,
} from './accounts.js';
import { BillingError } from './billing.js';
import { ApiError, readJson, sendJson, sendText } from './host.js';
import { FONT_FILES, fontSource } from 'docubase/src/build.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard-ui');
const UI_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};

// The page loads only its own script and stylesheet, cannot be framed, and can only talk to this host.
const PAGE_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'cross-origin-opener-policy': 'same-origin',
};

/**
 * The dashboard: a small web app on its own hostname where people sign up, add sites from git,
 * watch builds, set the assistant key and custom domains, and manage billing.
 *
 * Every request that changes something must send the header "x-docubase: 1". Browsers will not
 * let another site add that header without a CORS preflight, which this server never approves,
 * so together with the SameSite cookie a page elsewhere cannot act for a signed in user.
 */
export function createDashboard({ store, config, ops, billing, limitsFor, describe, requireSite, clientIp, log, info }) {
  const byAddress = createLimiter(30);
  const byEmail = createLimiter(10);
  const signups = createLimiter(5, 3600000);
  const uiCache = new Map();

  const secureCookies = () => !config.publicUrl || config.publicUrl.startsWith('https:');
  const publicPort = config.publicUrl && new URL(config.publicUrl).port ? `:${new URL(config.publicUrl).port}` : '';
  const dashboardUrl = () => `${config.publicUrl && config.publicUrl.startsWith('http:') ? 'http' : 'https'}://${config.dashboardHost}${publicPort}`;

  async function createUser(emailValue, password) {
    const email = normalizeEmail(emailValue);
    checkPassword(password);
    const user = { id: randomBytes(8).toString('hex'), email, passwordHash: await hashPassword(password), createdAt: new Date().toISOString(), plan: 'free' };
    await store.update((data) => {
      if (Object.values(data.users).some((u) => u.email === email)) throw new AccountError(409, 'An account with that email already exists. Sign in instead.');
      data.users[user.id] = user;
    });
    info('user.create', { user: user.id });
    return user;
  }

  async function startSession(res, user) {
    const token = newSessionToken();
    const now = Date.now();
    await store.update((data) => {
      for (const [id, session] of Object.entries(data.sessions)) if (session.expiresAt < now) delete data.sessions[id];
      data.sessions[tokenId(token)] = { userId: user.id, createdAt: now, expiresAt: now + SESSION_DAYS * 86400000 };
    });
    res.setHeader('set-cookie', sessionCookie(token, { secure: secureCookies() }));
  }

  function currentUser(req) {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token || token.length > 100) return null;
    const session = store.data.sessions[tokenId(token)];
    if (!session || session.expiresAt < Date.now()) return null;
    return store.user(session.userId);
  }

  function requireUser(req) {
    const user = currentUser(req);
    if (!user) throw new ApiError(401, 'Sign in first');
    return user;
  }

  /** A user only ever sees their own sites. Someone else's site answers exactly like a missing one. */
  function ownSite(user, slug) {
    const site = store.get(slug);
    if (!site || site.owner !== user.id) throw new ApiError(404, `No site named "${slug}"`);
    return site;
  }

  function me(user) {
    return {
      user: publicUser(user),
      limits: limitsFor(user),
      sites: store.sitesOf(user.id).length,
      billing: { enabled: billing.enabled },
    };
  }

  async function serveUi(res, pathname) {
    // The dashboard uses the same bundled serif as the docs theme.
    if (pathname.startsWith('/fonts/') && FONT_FILES.includes(pathname.slice(7))) {
      let body = uiCache.get(pathname);
      if (!body) {
        body = await readFile(fontSource(pathname.slice(7)));
        uiCache.set(pathname, body);
      }
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
      return res.end(body);
    }
    const entry = UI_FILES[pathname];
    if (!entry) return sendText(res, 404, 'Not found', PAGE_HEADERS);
    let body = uiCache.get(entry.file);
    if (!body) {
      body = await readFile(path.join(UI_DIR, entry.file));
      uiCache.set(entry.file, body);
    }
    res.writeHead(200, { 'content-type': entry.type, 'cache-control': 'no-cache', ...PAGE_HEADERS });
    res.end(body);
  }

  async function login(req, res) {
    const body = await readJson(req);
    const ip = clientIp(req);
    let email;
    try {
      email = normalizeEmail(body.email);
    } catch {
      throw new ApiError(400, 'Enter your email and password');
    }
    if (byAddress.blocked(ip) || byEmail.blocked(email)) throw new ApiError(429, 'Too many attempts. Wait a minute and try again.');
    const user = store.userByEmail(email);
    // Always compare against a hash, so an unknown email takes as long as a wrong password.
    const ok = await verifyPassword(String(body.password ?? ''), user ? user.passwordHash : await decoyHash());
    if (!user || !ok) {
      byAddress.record(ip);
      byEmail.record(email);
      throw new ApiError(401, 'That email and password do not match an account');
    }
    byEmail.reset(email);
    await startSession(res, user);
    info('user.login', { user: user.id });
    return sendJson(res, 200, me(user));
  }

  async function signup(req, res) {
    if (config.signup !== 'open') throw new ApiError(403, 'Sign up is closed on this server. Ask the administrator for an account.');
    const ip = clientIp(req);
    if (signups.blocked(ip)) throw new ApiError(429, 'Too many new accounts from this address. Try again later.');
    const body = await readJson(req);
    const user = await createUser(body.email, body.password);
    signups.record(ip);
    await startSession(res, user);
    return sendJson(res, 201, me(user));
  }

  async function logout(req, res) {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await store.update((data) => { delete data.sessions[tokenId(token)]; });
    res.setHeader('set-cookie', clearedCookie({ secure: secureCookies() }));
    return sendJson(res, 200, { ok: true });
  }

  async function changePassword(req, res, user) {
    const body = await readJson(req);
    if (!(await verifyPassword(String(body.current ?? ''), user.passwordHash))) throw new ApiError(401, 'The current password is wrong');
    checkPassword(body.next);
    const passwordHash = await hashPassword(body.next);
    const keep = tokenId(readCookie(req, SESSION_COOKIE));
    await store.update((data) => {
      data.users[user.id].passwordHash = passwordHash;
      // Signing out everywhere else is the point of changing a password after a leak.
      for (const [id, session] of Object.entries(data.sessions)) if (session.userId === user.id && id !== keep) delete data.sessions[id];
    });
    info('user.password', { user: user.id });
    return sendJson(res, 200, { ok: true });
  }

  async function deleteAccount(req, res, user) {
    const body = await readJson(req);
    if (!(await verifyPassword(String(body.password ?? ''), user.passwordHash))) throw new ApiError(401, 'The password is wrong');
    if (user.billing?.status && ['active', 'trialing', 'past_due'].includes(user.billing.status)) {
      throw new ApiError(409, 'Cancel your subscription in Billing first, then delete the account.');
    }
    await ops.removeUser(user.id);
    res.setHeader('set-cookie', clearedCookie({ secure: secureCookies() }));
    return sendJson(res, 200, { deleted: true });
  }

  async function sitesApi(req, res, user, [slug, action, ...rest]) {
    if (rest.length) throw new ApiError(404, 'Unknown route');
    const limits = limitsFor(user);
    if (!slug) {
      if (req.method === 'GET') return sendJson(res, 200, { sites: store.sitesOf(user.id).map(describe) });
      if (req.method === 'POST') return sendJson(res, 201, await ops.create(await readJson(req), { owner: user.id }));
      throw new ApiError(405, 'Use GET or POST');
    }
    ownSite(user, slug);
    if (!action) {
      if (req.method === 'GET') return sendJson(res, 200, { site: describe(requireSite(slug)) });
      if (req.method === 'PATCH') return sendJson(res, 200, await ops.update(slug, await readJson(req)));
      if (req.method === 'DELETE') return sendJson(res, 200, await ops.remove(slug));
      throw new ApiError(405, 'Use GET, PATCH or DELETE');
    }
    if (action === 'deploy' && req.method === 'POST') return sendJson(res, 202, ops.deploy(slug));
    if (action === 'assistant-key') {
      if (req.method === 'PUT') {
        if (!limits.assistant) throw new ApiError(403, 'The assistant is part of the paid plan. Upgrade in Billing to turn it on.');
        return sendJson(res, 200, await ops.setAssistantKey(slug, await readJson(req)));
      }
      if (req.method === 'DELETE') return sendJson(res, 200, await ops.clearAssistantKey(slug));
    }
    if (action === 'domains' && req.method === 'PUT') {
      const body = await readJson(req);
      if (!limits.customDomains && Array.isArray(body.domains) && body.domains.length > 0) throw new ApiError(403, 'Custom domains are part of the paid plan. Upgrade in Billing to add one.');
      return sendJson(res, 200, await ops.requestDomains(slug, body));
    }
    if (action === 'verify-domains' && req.method === 'POST') {
      if (!limits.customDomains) throw new ApiError(403, 'Custom domains are part of the paid plan.');
      return sendJson(res, 200, await ops.verifyDomains(slug));
    }
    throw new ApiError(404, 'Unknown route');
  }

  async function billingApi(req, res, user, [action]) {
    if (!billing.enabled) throw new ApiError(404, 'Billing is not set up on this server');
    if (req.method !== 'POST') throw new ApiError(405, 'Use POST');
    const back = `${dashboardUrl()}/#/billing`;
    try {
      if (action === 'checkout') {
        if (limitsFor(user).plan === 'pro') throw new ApiError(409, 'You already have the paid plan');
        return sendJson(res, 200, { url: await billing.checkout(user, { successUrl: `${back}?done=1`, cancelUrl: back }) });
      }
      if (action === 'portal') return sendJson(res, 200, { url: await billing.portal(user, { returnUrl: back }) });
    } catch (error) {
      if (error instanceof BillingError) {
        if (error.providerStatus) log.error(`billing: Stripe answered ${error.providerStatus}`);
        throw new ApiError(error.status, error.message);
      }
      throw error;
    }
    throw new ApiError(404, 'Unknown route');
  }

  async function api(req, res, parts) {
    if (req.method !== 'GET' && req.headers['x-docubase'] !== '1') throw new ApiError(403, 'Missing the x-docubase header');
    const [resource, ...rest] = parts;
    if (resource === 'session') {
      if (req.method === 'GET') {
        const user = currentUser(req);
        return sendJson(res, 200, user ? me(user) : { user: null, signup: config.signup, billing: { enabled: billing.enabled } });
      }
      if (req.method === 'POST') return login(req, res);
      if (req.method === 'DELETE') return logout(req, res);
      throw new ApiError(405, 'Use GET, POST or DELETE');
    }
    if (resource === 'signup' && req.method === 'POST') return signup(req, res);

    const user = requireUser(req);
    if (resource === 'sites') return sitesApi(req, res, user, rest);
    if (resource === 'billing') return billingApi(req, res, user, rest);
    if (resource === 'account') {
      if (rest[0] === 'password' && req.method === 'POST') return changePassword(req, res, user);
      if (!rest.length && req.method === 'DELETE') return deleteAccount(req, res, user);
    }
    throw new ApiError(404, 'Unknown route');
  }

  return {
    createUser,
    publicUser,
    async handle(req, res, pathname) {
      try {
        if (pathname.startsWith('/api/')) return await api(req, res, pathname.slice(5).split('/').filter(Boolean));
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });
        return await serveUi(res, pathname);
      } catch (error) {
        if (error instanceof AccountError) throw new ApiError(error.status, error.message);
        throw error;
      }
    },
  };
}
