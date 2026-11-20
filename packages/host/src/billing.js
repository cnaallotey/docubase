import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stripe billing over its REST API, without the Stripe SDK. Only three calls are needed: create a
 * Checkout session to subscribe, create a Billing Portal session to manage or cancel, and receive
 * signed webhooks that say what the subscription is now. Card details never touch this server.
 */

const STRIPE_API = 'https://api.stripe.com/v1';
const SIGNATURE_TOLERANCE_SECONDS = 300;
const ACTIVE = new Set(['active', 'trialing', 'past_due']);

export class BillingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Stripe takes form encoded bodies with bracketed keys, such as line_items[0][price]. */
export function formEncode(values, prefix = '') {
  const parts = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') parts.push(formEncode(value, name));
    else parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return parts.filter(Boolean).join('&');
}

/**
 * Check the Stripe-Signature header: "t=<unix time>,v1=<hex hmac>[,v1=...]". The signed text is
 * "<t>.<raw body>". Old timestamps are refused so a captured webhook cannot be replayed later.
 */
export function verifyStripeSignature(secret, rawBody, header, now = Date.now()) {
  const fields = String(header || '').split(',').map((part) => part.trim().split('='));
  const timestamp = Number(fields.find(([k]) => k === 't')?.[1]);
  const signatures = fields.filter(([k, v]) => k === 'v1' && /^[0-9a-f]{64}$/i.test(v || '')).map(([, v]) => Buffer.from(v, 'hex'));
  if (!Number.isInteger(timestamp) || signatures.length === 0) return false;
  if (Math.abs(now / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  return signatures.some((sig) => sig.length === expected.length && timingSafeEqual(sig, expected));
}

export function planForStatus(status) {
  return ACTIVE.has(status) ? 'pro' : 'free';
}

export function createBilling({ secretKey, priceId, webhookSecret, fetchImpl = globalThis.fetch, apiBase = STRIPE_API }) {
  const enabled = Boolean(secretKey && priceId && webhookSecret);

  async function call(pathName, values) {
    let response;
    try {
      response = await fetchImpl(`${apiBase}${pathName}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/x-www-form-urlencoded', 'stripe-version': '2024-06-20' },
        body: formEncode(values),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
    } catch {
      throw new BillingError(502, 'The payment provider could not be reached. Try again in a moment.');
    }
    const data = await response.json().catch(() => ({}));
    // Stripe's error text can name internal ids, so only the status is reported to the user.
    if (!response.ok) throw Object.assign(new BillingError(502, 'The payment provider refused the request. Try again later.'), { providerStatus: response.status });
    return data;
  }

  return {
    enabled,

    /** Start a subscription. Returns the address of Stripe's hosted payment page. */
    async checkout(user, { successUrl, cancelUrl }) {
      const session = await call('/checkout/sessions', {
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: user.id,
        ...(user.billing?.customerId ? { customer: user.billing.customerId } : { customer_email: user.email }),
        subscription_data: { metadata: { docubase_user: user.id } },
        allow_promotion_codes: 'true',
      });
      if (typeof session.url !== 'string' || !session.url.startsWith('https://')) throw new BillingError(502, 'The payment provider returned no payment page.');
      return session.url;
    },

    /** Manage payment details or cancel. Returns the address of Stripe's hosted portal. */
    async portal(user, { returnUrl }) {
      if (!user.billing?.customerId) throw new BillingError(400, 'There is no subscription to manage yet.');
      const session = await call('/billing_portal/sessions', { customer: user.billing.customerId, return_url: returnUrl });
      if (typeof session.url !== 'string' || !session.url.startsWith('https://')) throw new BillingError(502, 'The payment provider returned no portal page.');
      return session.url;
    },

    verify(rawBody, header) {
      return verifyStripeSignature(webhookSecret, rawBody, header);
    },

    /**
     * Turn a verified webhook event into a change for one user, or null when it does not matter.
     * Returns { userId?, customerId, subscriptionId, status } where userId is only known on checkout.
     */
    interpret(event) {
      const object = event?.data?.object;
      if (!object || typeof object !== 'object') return null;
      if (event.type === 'checkout.session.completed' && object.mode === 'subscription') {
        return {
          userId: typeof object.client_reference_id === 'string' ? object.client_reference_id : null,
          customerId: String(object.customer || ''),
          subscriptionId: String(object.subscription || ''),
          status: 'active',
        };
      }
      if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
        return {
          userId: typeof object.metadata?.docubase_user === 'string' ? object.metadata.docubase_user : null,
          customerId: String(object.customer || ''),
          subscriptionId: String(object.id || ''),
          status: event.type === 'customer.subscription.deleted' ? 'canceled' : String(object.status || ''),
        };
      }
      return null;
    },
  };
}
