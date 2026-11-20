import { createServer } from 'node:http';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { promises as dns } from 'node:dns';
import path from 'node:path';
import net from 'node:net';
import { createAssistant } from 'docubase/src/assistant.js';
import { createMcpHandler, createMcpHttp, packageVersion } from 'docubase/src/mcp.js';
import { decodePath, serveStatic } from 'docubase/src/static.js';
import { buildSite, pruneDeploys } from './builder.js';
import { newSecret, open, safeEqual, seal, verifyGithubSignature } from './crypto.js';
import { checkBranch, checkDocsDir, parseRepoUrl, RepoError } from './git.js';
import { guardedFetch } from './netguard.js';
import { Store } from './store.js';
import { AccountError } from './accounts.js';
import { createBilling } from './billing.js';
import { createDashboard } from './dashboard.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED = new Set(['admin', 'api', 'www', 'app', 'dashboard', 'mail', 'status', 'ns1', 'ns2', 'smtp', 'ftp']);
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const API_BODY_LIMIT = 16 * 1024;
const DOMAIN_CHALLENGE = '_docubase-challenge';
const WEBHOOK_BODY_LIMIT = 5 * 1024 * 1024;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}

export function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(text);
}

export async function readBody(req, limit) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw new ApiError(413, 'The request body is too large');
    }
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

export async function readJson(req) {
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) throw new ApiError(415, 'Send JSON with content-type application/json');
  const raw = await readBody(req, API_BODY_LIMIT);
  try {
    const value = JSON.parse(raw.toString('utf8') || '{}');
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new ApiError(400, 'The request body is not a valid JSON object');
  }
}

export function hostOf(req) {
  const raw = String(req.headers.host || '').toLowerCase();
  if (raw.startsWith('[')) return raw.slice(0, raw.indexOf(']') + 1);
  return raw.replace(/:\d+$/, '').replace(/\.$/, '');
}

function normalizeDomain(value, baseDomain) {
  const domain = String(value).trim().toLowerCase().replace(/\.$/, '');
  if (!HOSTNAME.test(domain) || net.isIP(domain)) throw new ApiError(400, `"${String(value).slice(0, 80)}" is not a valid domain name`);
  if (domain === baseDomain || domain.endsWith(`.${baseDomain}`)) throw new ApiError(400, `Domains under ${baseDomain} are reserved for site names`);
  return domain;
}

/**
 * The hosting service. It keeps a list of sites, builds each from its git repository, serves the result
 * by hostname, and answers assistant questions per site with a key stored encrypted on this server.
 *
 * `unsafeForTests` loosens network checks so tests can use local repositories and a local model server.
 * It exists only as an option of this function, never as an environment variable.
 */
export function createHost({ settings, log = console, buildFn = buildSite, unsafeForTests = {} } = {}) {
  const config = { ...settings, allowFileRepos: Boolean(unsafeForTests.allowFileRepos), allowPrivateProviders: Boolean(unsafeForTests.allowPrivateProviders) };
  const store = new Store(path.join(config.dataDir, 'sites.json'));
  const assistants = new Map();
  const mcps = new Map();
  const authFailures = new Map();
  const waiting = [];
  const running = new Map();
  const again = new Set();
  let closing = false;
  let server = null;

  const assistantFetch = unsafeForTests.allowPrivateProviders ? globalThis.fetch : guardedFetch();
  const context = (site, purpose) => `site:${site.id}:${purpose}`;
  const deployDir = (site) => path.join(config.dataDir, 'deploys', site.id, site.deploy.id);
  // Behind a proxy the public address has no port. On a laptop it does, and site links must keep it.
  const publicPort = config.publicUrl && new URL(config.publicUrl).port ? `:${new URL(config.publicUrl).port}` : '';
  const siteUrl = (site) => `${config.publicUrl && config.publicUrl.startsWith('http:') ? 'http' : 'https'}://${site.slug}.${config.baseDomain}${publicPort}`;
  const info = (event, data = {}) => log.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
  const resolveTxt = unsafeForTests.resolveTxt || ((name) => dns.resolveTxt(name));
  const billing = createBilling({ ...(config.stripe || {}), fetchImpl: unsafeForTests.stripeFetch, apiBase: unsafeForTests.stripeApi });

  /**
   * What a user may do. Without billing there are no plans, only a per user site cap. With billing,
   * the free plan gets fewer sites and no custom domains or assistant. An admin can set a plan by hand.
   */
  function limitsFor(user) {
    if (!billing.enabled) return { plan: 'none', maxSites: config.userMaxSites, customDomains: true, assistant: true };
    const plan = user?.planOverride || user?.plan || 'free';
    if (plan === 'pro') return { plan, maxSites: config.proPlanSites, customDomains: true, assistant: true };
    return { plan: 'free', maxSites: config.freePlanSites, customDomains: false, assistant: false };
  }

  /** Sites made with the admin API have no owner and no plan limits. */
  const siteLimits = (site) => (site.owner ? limitsFor(store.user(site.owner)) : { customDomains: true, assistant: true });

  function describe(site) {
    return {
      slug: site.slug,
      url: siteUrl(site),
      repo: site.repo,
      branch: site.branch,
      dir: site.dir,
      domains: site.domains,
      pendingDomains: (site.pendingDomains || []).map((p) => ({ domain: p.domain, record: `${DOMAIN_CHALLENGE}.${p.domain}`, value: `docubase-verify=${p.token}`, addedAt: p.addedAt })),
      createdAt: site.createdAt,
      hasRepoToken: Boolean(site.secrets.repoToken),
      hasAssistantKey: Boolean(site.secrets.assistantKey),
      deploy: site.deploy,
      status: site.status,
    };
  }

  function siteForHost(host) {
    const suffix = `.${config.baseDomain}`;
    if (host.endsWith(suffix)) {
      const slug = host.slice(0, -suffix.length);
      return SLUG.test(slug) ? store.get(slug) : null;
    }
    const site = store.findByDomain(host);
    return site && siteLimits(site).customDomains ? site : null;
  }

  /* ------------------------------------------------------------- builds */

  async function note(slug, patch, line) {
    await store.update((data) => {
      const site = data.sites[slug];
      if (!site) return;
      site.status = { ...site.status, ...patch };
      if (line) site.status.log = [...(site.status.log || []), { at: new Date().toISOString(), message: String(line).slice(0, 300) }].slice(-20);
    });
  }

  async function runBuild(slug) {
    const site = store.get(slug);
    if (!site) return;
    await note(slug, { state: 'building', startedAt: new Date().toISOString(), error: null }, 'Build started');
    info('build.start', { slug });
    try {
      const repoToken = site.secrets.repoToken ? open(config.masterKey, context(site, 'repo'), site.secrets.repoToken) : null;
      const result = await buildFn({ site, repoToken, dataDir: config.dataDir, settings: config });
      const stillThere = store.get(slug);
      if (!stillThere) {
        await rm(path.join(config.dataDir, 'deploys', site.id), { recursive: true, force: true });
        return;
      }
      const previous = stillThere.deploy ? stillThere.deploy.id : null;
      await store.update((data) => {
        const s = data.sites[slug];
        s.deploy = { id: result.deployId, commit: result.commit, builtAt: new Date().toISOString(), pages: result.pages };
        s.status = { ...s.status, state: 'ready', finishedAt: new Date().toISOString(), error: null };
        s.status.log = [...(s.status.log || []), ...result.warnings.slice(0, 3).map((w) => ({ at: new Date().toISOString(), message: `warning: ${w}` })), { at: new Date().toISOString(), message: `Deployed ${result.commit.slice(0, 7)} (${result.pages} pages)` }].slice(-20);
      });
      assistants.delete(slug);
      mcps.delete(slug);
      await pruneDeploys(config.dataDir, site.id, [result.deployId, previous].filter(Boolean));
      info('build.ok', { slug, commit: result.commit, pages: result.pages });
    } catch (error) {
      const message = error instanceof RepoError ? error.message : 'The build failed unexpectedly';
      if (!(error instanceof RepoError)) log.error(`build error for ${slug}: ${error.stack || error.message}`);
      await note(slug, { state: 'failed', finishedAt: new Date().toISOString(), error: message }, `Build failed: ${message}`).catch(() => {});
      info('build.failed', { slug, error: message });
    }
  }

  function pump() {
    while (!closing && running.size < config.buildConcurrency && waiting.length > 0) {
      const slug = waiting.shift();
      const promise = runBuild(slug).finally(() => {
        running.delete(slug);
        if (again.delete(slug)) waiting.push(slug);
        pump();
      });
      running.set(slug, promise);
    }
  }

  function enqueue(slug) {
    if (running.has(slug)) again.add(slug);
    else if (!waiting.includes(slug)) waiting.push(slug);
    pump();
  }

  /* ---------------------------------------------------------- assistant */

  async function assistantFor(site) {
    const allowed = siteLimits(site).assistant;
    const stamp = `${site.deploy.id}:${site.assistantKeyAt || 0}:${allowed}`;
    const cached = assistants.get(site.slug);
    if (cached && cached.stamp === stamp) return cached.assistant;

    const dir = deployDir(site);
    const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8'));
    const apiKey = allowed && site.secrets.assistantKey ? open(config.masterKey, context(site, 'assistant'), site.secrets.assistantKey) : null;
    const assistant = createAssistant({
      env: apiKey ? { DOCUBASE_API_KEY: apiKey } : {},
      fetchImpl: assistantFetch,
      log,
      keyMessage: 'The assistant is not set up for this site yet.',
    });
    let chunks = [];
    if (meta.config.assistant.enabled) chunks = JSON.parse(await readFile(path.join(dir, 'site', 'docubase-chunks.json'), 'utf8'));
    // The reader's address comes from this server's own proxy setting, never from the customer's config.
    assistant.configure({ title: meta.config.title, assistant: { ...meta.config.assistant, trustProxy: config.trustProxy } }, chunks);
    assistants.set(site.slug, { stamp, assistant });
    return assistant;
  }

  /** The site's MCP endpoint, rebuilt after each deploy. Null when the site has not turned it on. */
  async function mcpFor(site) {
    const cached = mcps.get(site.slug);
    if (cached && cached.deployId === site.deploy.id) return cached.serve;
    const dir = deployDir(site);
    const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8'));
    let serve = null;
    if (meta.config.mcp?.enabled) {
      const snapshot = JSON.parse(await readFile(path.join(dir, 'site', 'docubase-mcp.json'), 'utf8'));
      const handler = createMcpHandler({ getSite: () => snapshot, version: await packageVersion() });
      // The reader's address comes from this server's proxy setting, never from the customer's config.
      serve = createMcpHttp({ getHandler: () => handler, ...meta.config.mcp, trustProxy: false, clientIp });
    }
    mcps.set(site.slug, { deployId: site.deploy.id, serve });
    return serve;
  }

  /* ------------------------------------------------------------ site IO */

  async function serveSite(req, res, host, pathname) {
    const site = siteForHost(host);
    if (!site) {
      sendText(res, 404, 'No site is hosted at this address.');
      return;
    }
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader('x-frame-options', 'SAMEORIGIN');

    if (!site.deploy) {
      const failed = site.status.state === 'failed';
      sendText(res, failed ? 502 : 503, failed ? 'This site has not been deployed yet. The first build failed.' : 'This site is being built. Try again in a minute.', { 'retry-after': '15' });
      return;
    }
    if (pathname === '/__docubase/ask') {
      try {
        await (await assistantFor(site)).handle(req, res);
      } catch (error) {
        log.error(`assistant error for ${site.slug}: ${error.message}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'The assistant is unavailable.' });
      }
      return;
    }
    if (pathname === '/__docubase/mcp') {
      const serve = await mcpFor(site);
      if (serve) {
        await serve(req, res);
        return;
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });
      return;
    }
    await serveStatic(res, path.join(deployDir(site), 'site'), pathname, { cache: 'no-cache' });
  }

  /* ---------------------------------------------------------------- API */

  /** Behind a reverse proxy every request comes from the proxy, so read the address it forwards. */
  function clientIp(req) {
    if (config.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((v) => v.trim()).filter(Boolean);
      if (forwarded.length) return forwarded[forwarded.length - 1]; // the last entry is the one our own proxy added
    }
    return req.socket.remoteAddress || 'unknown';
  }

  /** Failed attempts are counted per address. Once there are too many, even the right token waits, so guessing gains nothing. */
  function authorize(req) {
    const ip = clientIp(req);
    const now = Date.now();
    const recent = (authFailures.get(ip) || []).filter((t) => now - t < 60000);
    if (recent.length >= 20) throw new ApiError(429, 'Too many failed attempts. Wait a minute.');
    const header = String(req.headers.authorization || '');
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!given || !safeEqual(given, config.adminToken)) {
      recent.push(now);
      authFailures.set(ip, recent);
      if (authFailures.size > 5000) authFailures.clear();
      throw new ApiError(401, 'A valid admin token is required');
    }
  }

  function requireSite(slug) {
    const site = store.get(slug);
    if (!site) throw new ApiError(404, `No site named "${slug}"`);
    return site;
  }

  function validateRepoFields(body, { requireRepo }) {
    const out = {};
    if (requireRepo || 'repo' in body) {
      try {
        out.repo = parseRepoUrl(body.repo, { allowFile: config.allowFileRepos }).href;
      } catch (error) {
        throw new ApiError(400, error.message);
      }
    }
    try {
      if ('branch' in body || requireRepo) out.branch = checkBranch(body.branch ?? 'main');
      if ('dir' in body || requireRepo) out.dir = checkDocsDir(body.dir ?? '');
    } catch (error) {
      throw new ApiError(400, error.message);
    }
    if ('repoToken' in body && body.repoToken !== null && (typeof body.repoToken !== 'string' || body.repoToken.length < 8 || body.repoToken.length > 400 || /\s/.test(body.repoToken))) {
      throw new ApiError(400, '"repoToken" must be a token with no spaces');
    }
    return out;
  }

  /* --------------------------------------------------------- site operations */
  // Shared by the admin API and the dashboard. Callers check who may act on which site first.

  const ops = {
    async create(body, { owner = null } = {}) {
      const name = String(body.slug ?? '');
      if (!SLUG.test(name) || RESERVED.has(name)) throw new ApiError(400, '"slug" must be 1 to 40 lowercase letters, numbers or dashes, and not a reserved name');
      const fields = validateRepoFields(body, { requireRepo: true });
      const id = randomBytes(6).toString('hex');
      const webhookSecret = newSecret();
      const record = {
        id,
        slug: name,
        ...fields,
        domains: [],
        createdAt: new Date().toISOString(),
        assistantKeyAt: 0,
        ...(owner ? { owner } : {}),
        secrets: {
          webhook: seal(config.masterKey, `site:${id}:webhook`, webhookSecret),
          ...(body.repoToken ? { repoToken: seal(config.masterKey, `site:${id}:repo`, body.repoToken) } : {}),
        },
        deploy: null,
        status: { state: 'queued', log: [{ at: new Date().toISOString(), message: 'Site created' }] },
      };
      await store.update((data) => {
        if (data.sites[name]) throw new ApiError(409, `A site named "${name}" already exists`);
        if (Object.keys(data.sites).length >= config.maxSites) throw new ApiError(403, `This server is limited to ${config.maxSites} sites`);
        if (owner) {
          const limit = limitsFor(data.users[owner]).maxSites;
          const count = Object.values(data.sites).filter((x) => x.owner === owner).length;
          if (count >= limit) throw new ApiError(403, limit === 0 ? 'Your plan does not include sites. Upgrade to add one.' : `Your plan allows ${limit} site${limit === 1 ? '' : 's'}. Delete one or upgrade to add more.`);
        }
        data.sites[name] = record;
      });
      enqueue(name);
      info('site.create', { slug: name, owner: owner ?? 'admin' });
      return { site: describe(record), webhook: { secret: webhookSecret, url: `${config.publicUrl || ''}/__host/webhook/${name}` } };
    },

    async update(slug, body) {
      const fields = validateRepoFields(body, { requireRepo: false });
      await store.update((data) => {
        const s = data.sites[slug];
        Object.assign(s, fields);
        if ('repoToken' in body) {
          if (body.repoToken === null) delete s.secrets.repoToken;
          else s.secrets.repoToken = seal(config.masterKey, `site:${s.id}:repo`, body.repoToken);
        }
      });
      enqueue(slug);
      return { site: describe(store.get(slug)) };
    },

    async remove(slug) {
      const site = requireSite(slug);
      await store.update((data) => { delete data.sites[slug]; });
      assistants.delete(slug);
      mcps.delete(slug);
      await rm(path.join(config.dataDir, 'deploys', site.id), { recursive: true, force: true });
      info('site.delete', { slug });
      return { deleted: slug };
    },

    deploy(slug) {
      enqueue(slug);
      return { queued: true };
    },

    async setAssistantKey(slug, body) {
      if (typeof body.key !== 'string' || body.key.length < 8 || body.key.length > 400 || /\s/.test(body.key)) throw new ApiError(400, '"key" must be your model provider API key');
      await store.update((data) => {
        const s = data.sites[slug];
        s.secrets.assistantKey = seal(config.masterKey, `site:${s.id}:assistant`, body.key);
        s.assistantKeyAt = Date.now();
      });
      assistants.delete(slug);
      info('site.assistant-key.set', { slug });
      return { hasAssistantKey: true };
    },

    async clearAssistantKey(slug) {
      await store.update((data) => {
        delete data.sites[slug].secrets.assistantKey;
        data.sites[slug].assistantKeyAt = Date.now();
      });
      assistants.delete(slug);
      return { hasAssistantKey: false };
    },

    async setDomains(slug, body) {
      if (!Array.isArray(body.domains) || body.domains.length > 10) throw new ApiError(400, '"domains" must be a list of up to 10 domain names');
      const domains = [...new Set(body.domains.map((d) => normalizeDomain(d, config.baseDomain)))];
      await store.update((data) => {
        for (const domain of domains) {
          const owner = Object.values(data.sites).find((x) => x.slug !== slug && x.domains.includes(domain));
          if (owner) throw new ApiError(409, `${domain} is already used by another site`);
        }
        data.sites[slug].domains = domains;
        data.sites[slug].pendingDomains = (data.sites[slug].pendingDomains || []).filter((p) => !domains.includes(p.domain));
      });
      return { domains };
    },

    /**
     * Domains added from the dashboard wait until the owner proves control of them with a DNS TXT
     * record, so nobody can claim a name they do not own. Removed names are dropped at once.
     */
    async requestDomains(slug, body) {
      if (!Array.isArray(body.domains) || body.domains.length > 10) throw new ApiError(400, '"domains" must be a list of up to 10 domain names');
      const wanted = [...new Set(body.domains.map((d) => normalizeDomain(d, config.baseDomain)))];
      await store.update((data) => {
        const s = data.sites[slug];
        const pending = (s.pendingDomains || []).filter((p) => wanted.includes(p.domain));
        s.domains = s.domains.filter((d) => wanted.includes(d));
        for (const domain of wanted) {
          if (s.domains.includes(domain) || pending.some((p) => p.domain === domain)) continue;
          pending.push({ domain, token: randomBytes(16).toString('hex'), addedAt: new Date().toISOString() });
        }
        s.pendingDomains = pending;
      });
      return { site: describe(store.get(slug)) };
    },

    async verifyDomains(slug) {
      const site = requireSite(slug);
      const results = [];
      for (const pending of site.pendingDomains || []) {
        let records = [];
        try {
          records = (await resolveTxt(`${DOMAIN_CHALLENGE}.${pending.domain}`)).map((chunks) => chunks.join(''));
        } catch {
          records = [];
        }
        results.push({ domain: pending.domain, verified: records.includes(`docubase-verify=${pending.token}`) });
      }
      const verified = results.filter((r) => r.verified).map((r) => r.domain);
      if (verified.length) {
        await store.update((data) => {
          const s = data.sites[slug];
          for (const domain of verified) {
            const taken = Object.values(data.sites).find((x) => x.slug !== slug && x.domains.includes(domain));
            if (taken) {
              results.find((r) => r.domain === domain).verified = false;
              results.find((r) => r.domain === domain).error = 'Already used by another site';
              continue;
            }
            if (s.domains.length >= 10) break;
            s.domains.push(domain);
            s.pendingDomains = (s.pendingDomains || []).filter((p) => p.domain !== domain);
          }
        });
        info('site.domains.verified', { slug, count: verified.length });
      }
      return { results, site: describe(store.get(slug)) };
    },

    /** Delete a user, their sessions and every site they own. */
    async removeUser(userId) {
      for (const site of store.sitesOf(userId)) await ops.remove(site.slug);
      await store.update((data) => {
        delete data.users[userId];
        for (const [id, session] of Object.entries(data.sessions)) if (session.userId === userId) delete data.sessions[id];
      });
      info('user.delete', { user: userId });
    },
  };

  async function api(req, res, pathname) {
    authorize(req);
    const parts = pathname.slice('/__host/api/'.length).split('/').filter(Boolean);
    const [resource, slug, action] = parts;
    if (resource === 'users') return usersApi(req, res, parts.slice(1));
    if (resource !== 'sites' || parts.length > 3) throw new ApiError(404, 'Unknown API route');

    if (!slug) {
      if (req.method === 'GET') return sendJson(res, 200, { sites: store.list().map(describe) });
      if (req.method === 'POST') return sendJson(res, 201, await ops.create(await readJson(req)));
      throw new ApiError(405, 'Use GET or POST');
    }

    const site = requireSite(slug);

    if (!action) {
      if (req.method === 'GET') return sendJson(res, 200, { site: describe(site) });
      if (req.method === 'PATCH') return sendJson(res, 200, await ops.update(slug, await readJson(req)));
      if (req.method === 'DELETE') return sendJson(res, 200, await ops.remove(slug));
      throw new ApiError(405, 'Use GET, PATCH or DELETE');
    }

    if (action === 'deploy') {
      if (req.method !== 'POST') throw new ApiError(405, 'Use POST');
      return sendJson(res, 202, ops.deploy(slug));
    }

    if (action === 'assistant-key') {
      if (req.method === 'PUT') return sendJson(res, 200, await ops.setAssistantKey(slug, await readJson(req)));
      if (req.method === 'DELETE') return sendJson(res, 200, await ops.clearAssistantKey(slug));
      throw new ApiError(405, 'Use PUT or DELETE. The key can be replaced or removed, never read back.');
    }

    if (action === 'domains') {
      if (req.method !== 'PUT') throw new ApiError(405, 'Use PUT with { "domains": [...] }');
      return sendJson(res, 200, await ops.setDomains(slug, await readJson(req)));
    }

    throw new ApiError(404, 'Unknown API route');
  }

  /** Admin view of dashboard accounts: list, create (for closed sign up), set a plan by hand, delete. */
  async function usersApi(req, res, [id, ...rest]) {
    if (rest.length) throw new ApiError(404, 'Unknown API route');
    const view = (u) => ({ ...dashboard.publicUser(u), planOverride: u.planOverride ?? null, sites: store.sitesOf(u.id).map((x) => x.slug) });
    if (!id) {
      if (req.method === 'GET') return sendJson(res, 200, { users: Object.values(store.data.users).map(view) });
      if (req.method === 'POST') {
        const body = await readJson(req);
        const user = await dashboard.createUser(body.email, body.password);
        return sendJson(res, 201, { user: view(user) });
      }
      throw new ApiError(405, 'Use GET or POST');
    }
    const user = store.user(id);
    if (!user) throw new ApiError(404, 'No such user');
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      if (!('plan' in body) || ![null, 'free', 'pro'].includes(body.plan)) throw new ApiError(400, '"plan" must be "free", "pro" or null to follow billing');
      await store.update((data) => {
        if (body.plan === null) delete data.users[id].planOverride;
        else data.users[id].planOverride = body.plan;
      });
      for (const site of store.sitesOf(id)) assistants.delete(site.slug);
      return sendJson(res, 200, { user: view(store.user(id)) });
    }
    if (req.method === 'DELETE') {
      await ops.removeUser(id);
      return sendJson(res, 200, { deleted: id });
    }
    throw new ApiError(405, 'Use PATCH or DELETE');
  }

  /** Stripe tells us when a subscription starts, changes or ends. Only signed events are read. */
  async function stripeWebhook(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' }, { allow: 'POST' });
    const raw = await readBody(req, WEBHOOK_BODY_LIMIT);
    if (!billing.enabled) return sendJson(res, 404, { error: 'Billing is not set up on this server' });
    if (!billing.verify(raw, req.headers['stripe-signature'])) return sendJson(res, 400, { error: 'Invalid signature' });
    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendJson(res, 400, { error: 'The payload is not JSON' });
    }
    const change = billing.interpret(event);
    if (!change) return sendJson(res, 200, { ignored: String(event.type || '').slice(0, 60) });
    const user = (change.userId && store.user(change.userId)) || store.userByCustomer(change.customerId);
    if (!user) {
      info('billing.unmatched', { type: event.type });
      return sendJson(res, 200, { ignored: 'no matching user' });
    }
    await store.update((data) => {
      const u = data.users[user.id];
      if (!u) return;
      // A late "updated" event for an old subscription must not undo a newer one.
      if (u.billing?.subscriptionId && change.subscriptionId && u.billing.subscriptionId !== change.subscriptionId && event.type !== 'checkout.session.completed' && change.status !== 'active' && change.status !== 'trialing') return;
      u.billing = { customerId: change.customerId || u.billing?.customerId || null, subscriptionId: change.subscriptionId || u.billing?.subscriptionId || null, status: change.status, updatedAt: new Date().toISOString() };
      u.plan = change.status === 'active' || change.status === 'trialing' || change.status === 'past_due' ? 'pro' : 'free';
    });
    for (const site of store.sitesOf(user.id)) assistants.delete(site.slug);
    info('billing.update', { user: user.id, status: change.status });
    return sendJson(res, 200, { ok: true });
  }

  const dashboard = createDashboard({ store, config, ops, billing, limitsFor, describe, requireSite, clientIp, log, info });

  async function webhook(req, res, pathname) {
    const slug = pathname.slice('/__host/webhook/'.length);
    const site = SLUG.test(slug) ? store.get(slug) : null;
    // The same answer for "no such site" and "bad signature", so the endpoint reveals nothing.
    const deny = () => sendJson(res, 401, { error: 'Invalid signature' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' }, { allow: 'POST' });
    const raw = await readBody(req, WEBHOOK_BODY_LIMIT);
    if (!site) return deny();
    const secret = open(config.masterKey, context(site, 'webhook'), site.secrets.webhook);

    if (req.headers['x-hub-signature-256']) {
      if (!verifyGithubSignature(secret, raw, req.headers['x-hub-signature-256'])) return deny();
      const event = String(req.headers['x-github-event'] || '');
      if (event === 'ping') return sendJson(res, 200, { ok: true });
      if (event !== 'push') return sendJson(res, 202, { ignored: `event ${event.slice(0, 40)}` });
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return sendJson(res, 400, { error: 'The payload is not JSON' });
      }
      if (payload.ref !== `refs/heads/${site.branch}`) return sendJson(res, 202, { ignored: 'other branch' });
    } else if (req.headers['x-gitlab-token']) {
      if (!safeEqual(req.headers['x-gitlab-token'], secret)) return deny();
      if (req.headers['x-gitlab-event'] !== 'Push Hook') return sendJson(res, 202, { ignored: 'not a push' });
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return sendJson(res, 400, { error: 'The payload is not JSON' });
      }
      if (payload.ref !== `refs/heads/${site.branch}`) return sendJson(res, 202, { ignored: 'other branch' });
    } else {
      return deny();
    }
    enqueue(slug);
    info('webhook.push', { slug });
    return sendJson(res, 202, { queued: true });
  }

  /* ------------------------------------------------------------- server */

  async function handle(req, res) {
    try {
      const pathname = decodePath(req.url);
      if (pathname === null) return sendText(res, 400, 'Bad request');
      const host = hostOf(req);

      if (pathname === '/__host/health') return sendJson(res, 200, { ok: true, sites: store.list().length, building: running.size });
      if (pathname === '/__host/tls-check') {
        // For a reverse proxy that issues certificates on demand (such as Caddy's "ask" option).
        const domain = String(new URL(req.url, 'http://x').searchParams.get('domain') || '').toLowerCase();
        const known = Boolean(siteForHost(domain)) || (config.adminHost !== null && domain === config.adminHost) || (Boolean(config.dashboardHost) && domain === config.dashboardHost);
        return sendText(res, known ? 200 : 404, known ? 'ok' : 'unknown domain');
      }
      if (pathname.startsWith('/__host/api/')) {
        if (config.adminHost && host !== config.adminHost) return sendText(res, 404, 'Not found');
        return await api(req, res, pathname);
      }
      if (pathname.startsWith('/__host/webhook/')) return await webhook(req, res, pathname);
      if (pathname === '/__host/stripe/webhook') return await stripeWebhook(req, res);
      if (config.dashboardHost && host === config.dashboardHost) return await dashboard.handle(req, res, pathname);
      return await serveSite(req, res, host, pathname);
    } catch (error) {
      if (error instanceof ApiError || error instanceof AccountError) {
        if (!res.headersSent) sendJson(res, error.status, { error: error.message });
        return;
      }
      log.error(`error: ${error.stack || error.message}`);
      if (!res.headersSent) sendText(res, 500, 'Server error');
      else res.end();
    }
  }

  return {
    store,
    settings: config,
    billing,
    async start() {
      await mkdir(path.join(config.dataDir, 'deploys'), { recursive: true });
      await rm(path.join(config.dataDir, 'tmp'), { recursive: true, force: true });
      await store.load();
      for (const site of store.list()) {
        if (site.status.state === 'building' || site.status.state === 'queued') enqueue(site.slug);
      }
      server = createServer(handle);
      server.requestTimeout = 60000;
      server.headersTimeout = 20000;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, resolve);
      });
      const address = server.address();
      return { port: address.port, url: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${address.port}` };
    },
    /** Resolves when no build is queued or running. Used by tests and by shutdown. */
    async idle() {
      while (running.size > 0 || waiting.length > 0) await Promise.allSettled([...running.values()]);
    },
    async close() {
      closing = true;
      waiting.length = 0;
      await Promise.allSettled([...running.values()]);
      if (server) {
        await new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections?.();
        });
      }
    },
  };
}
