import { assertPublicHost, isPrivateAddress } from '@docubase/core';

export { assertPublicHost, isPrivateAddress };

/**
 * Wrap fetch so a site's assistant can only call public https servers. The address is checked just
 * before the request. A host that changes its answer between the check and the connection is a
 * known limit of this approach, so deploy this server in a network that cannot reach internal services.
 */
export function guardedFetch(fetchImpl = globalThis.fetch, { allowHttp = false, lookup } = {}) {
  return async (url, init) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) throw new Error('Only https servers are allowed');
    if (!allowHttp) await assertPublicHost(parsed.hostname, lookup);
    return fetchImpl(url, { ...init, redirect: 'error' });
  };
}
