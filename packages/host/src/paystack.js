import { createHmac, timingSafeEqual } from 'node:crypto';
import { BillingError } from './billing-error.js';

/**
 * Paystack billing over its REST API, without an SDK. A subscription starts by initializing a
 * transaction against a plan (Paystack's hosted checkout page), is managed on Paystack's own
 * "manage subscription" page, and every change arrives as a webhook signed with the secret key.
 * Card details never touch this server.
 */

const PAYSTACK_API = 'https://api.paystack.co';
// "non-renewing" keeps access until the paid period ends; "attention" means a renewal failed and
// Paystack is still retrying, like Stripe's past_due.
const ACTIVE = new Set(['active', 'non-renewing', 'attention']);
const PLAN_CACHE_MS = 10 * 60 * 1000;

/** Paystack signs the raw body with HMAC SHA-512 of the secret key, in the x-paystack-signature header. */
export function verifyPaystackSignature(secretKey, rawBody, header) {
  const given = String(header || '');
  if (!/^[0-9a-f]{128}$/i.test(given)) return false;
  const expected = createHmac('sha512', secretKey).update(rawBody).digest();
  const sig = Buffer.from(given, 'hex');
  return sig.length === expected.length && timingSafeEqual(sig, expected);
}

export function createPaystackBilling({ secretKey, planCode, fetchImpl = globalThis.fetch, apiBase = PAYSTACK_API }) {
  const enabled = Boolean(secretKey && planCode);
  let plan = null;

  async function call(method, pathName, body) {
    let response;
    try {
      response = await fetchImpl(`${apiBase}${pathName}`, {
        method,
        headers: { authorization: `Bearer ${secretKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
    } catch {
      throw new BillingError(502, 'The payment provider could not be reached. Try again in a moment.');
    }
    const data = await response.json().catch(() => ({}));
    // Paystack's messages can name internal codes, so only the status is reported to the user.
    if (!response.ok || data.status !== true) throw Object.assign(new BillingError(502, 'The payment provider refused the request. Try again later.'), { providerStatus: response.status });
    return data.data || {};
  }

  /** The plan's amount and currency, which Paystack wants on the transaction as well. */
  async function planDetails() {
    if (plan && Date.now() - plan.at < PLAN_CACHE_MS) return plan;
    const data = await call('GET', `/plan/${encodeURIComponent(planCode)}`);
    if (!Number.isInteger(data.amount) || typeof data.currency !== 'string') throw new BillingError(502, 'The payment provider returned an unusable plan.');
    plan = { amount: data.amount, currency: data.currency, at: Date.now() };
    return plan;
  }

  const metadataOf = (data) => {
    if (data?.metadata && typeof data.metadata === 'object') return data.metadata;
    if (typeof data?.metadata === 'string') {
      try {
        const parsed = JSON.parse(data.metadata);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }
    return {};
  };
  const planCodeOf = (data) => (typeof data?.plan === 'string' ? data.plan : data?.plan?.plan_code) || null;

  return {
    enabled,
    provider: 'paystack',
    label: 'Paystack',
    isActive: (status) => ACTIVE.has(status),

    /** Start a subscription. Returns the address of Paystack's hosted payment page. */
    async checkout(user, { successUrl, cancelUrl }) {
      const { amount, currency } = await planDetails();
      const data = await call('POST', '/transaction/initialize', {
        email: user.email,
        amount,
        currency,
        plan: planCode,
        callback_url: successUrl,
        metadata: { docubase_user: user.id, cancel_action: cancelUrl },
      });
      if (typeof data.authorization_url !== 'string' || !data.authorization_url.startsWith('https://')) throw new BillingError(502, 'The payment provider returned no payment page.');
      return data.authorization_url;
    },

    /** Change the card or cancel. Returns the address of Paystack's manage subscription page. */
    async portal(user) {
      if (!user.billing?.subscriptionId) throw new BillingError(400, 'There is no subscription to manage yet. If you just paid, wait a moment and try again.');
      const data = await call('GET', `/subscription/${encodeURIComponent(user.billing.subscriptionId)}/manage/link`);
      if (typeof data.link !== 'string' || !data.link.startsWith('https://')) throw new BillingError(502, 'The payment provider returned no page to manage the subscription.');
      return data.link;
    },

    verify(rawBody, headers) {
      return verifyPaystackSignature(secretKey, rawBody, headers['x-paystack-signature']);
    },

    /**
     * Turn a verified webhook event into a change for one user, or null when it does not matter.
     * Returns { userId?, customerId, subscriptionId, status, fresh } where userId is only known on the
     * first payment, and fresh marks the start of a new subscription.
     */
    interpret(event) {
      const data = event?.data;
      if (!data || typeof data !== 'object') return null;
      const customerId = String(data.customer?.customer_code || '');
      const eventPlan = planCodeOf(data) || planCodeOf(data.subscription);
      // Events for other plans or one off payments on the same Paystack account are not ours.
      if (eventPlan && eventPlan !== planCode) return null;

      if (event.event === 'charge.success') {
        const meta = metadataOf(data);
        const userId = typeof meta.docubase_user === 'string' ? meta.docubase_user : null;
        if (!userId && !eventPlan) return null;
        return { userId, customerId, subscriptionId: null, status: 'active', fresh: Boolean(userId) };
      }
      if (event.event === 'subscription.create' || event.event === 'subscription.not_renew' || event.event === 'subscription.disable') {
        if (!eventPlan) return null;
        const fallback = event.event === 'subscription.disable' ? 'cancelled' : event.event === 'subscription.not_renew' ? 'non-renewing' : 'active';
        return {
          userId: null,
          customerId,
          subscriptionId: String(data.subscription_code || ''),
          status: typeof data.status === 'string' && data.status ? data.status : fallback,
          fresh: event.event === 'subscription.create',
        };
      }
      if (event.event === 'invoice.payment_failed') {
        if (!eventPlan) return null;
        return { userId: null, customerId, subscriptionId: String(data.subscription?.subscription_code || ''), status: 'attention', fresh: false };
      }
      return null;
    },
  };
}
