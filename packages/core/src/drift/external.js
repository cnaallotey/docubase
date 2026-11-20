import { assertPublicHost } from '../netguard.js';

const PRIVATE_NAME = /^(localhost|.*\.local|.*\.localhost|.*\.internal|example\.(com|org|net))$/i;
const FINE = new Set([401, 403, 429]); // the site is there but will not talk to a bot
const MAX_REDIRECTS = 5;

function skipped(url, ignore) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  return PRIVATE_NAME.test(parsed.hostname) || ignore.some((prefix) => url.startsWith(prefix));
}

/**
 * Links in a pull request are written by whoever opened it, so the check must not become a way to
 * probe the network it runs in. Every address is resolved and refused when it is not public, and
 * redirects are followed by hand so each hop gets the same check.
 */
async function request(url, method, { fetchImpl, timeoutMs, lookup }) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(current);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('unsupported address');
    await assertPublicHost(parsed.hostname, lookup);
    const res = await fetchImpl(current, { method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'docubase-check' } });
    try { await res.body?.cancel(); } catch { /* nothing to cancel */ }
    const location = res.headers?.get?.('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).href;
      continue;
    }
    return res.status;
  }
  throw Object.assign(new Error('too many redirects'), { code: 'TOO_MANY_REDIRECTS' });
}

async function probe(url, options) {
  try {
    let status = await request(url, 'HEAD', options);
    if (status >= 400) status = await request(url, 'GET', options); // some servers refuse HEAD
    return status >= 400 && !FINE.has(status) ? `answered ${status}` : null;
  } catch (error) {
    if (/not a public|public address|public host/.test(error.message)) return 'points at a private address and was not checked';
    return `could not be reached (${error.code ?? error.cause?.code ?? error.name ?? 'network error'})`;
  }
}

/** Check each distinct URL once. Returns a Map of url to a problem description. */
export async function checkExternal(urls, { fetchImpl = fetch, timeoutMs = 8000, ignore = [], concurrency = 6, lookup } = {}) {
  const queue = [...new Set(urls)].filter((u) => !skipped(u, ignore));
  const problems = new Map();
  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      const problem = await probe(url, { fetchImpl, timeoutMs, lookup });
      if (problem) problems.set(url, problem);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return problems;
}
