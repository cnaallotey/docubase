import path from 'node:path';
import { parseMasterKey } from './crypto.js';

export class SettingsError extends Error {}

function int(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new SettingsError(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

/** Read and check all settings from the environment. Anything wrong stops the server with a clear message. */
export function readSettings(env = process.env) {
  const token = String(env.DOCUBASE_ADMIN_TOKEN || '');
  if (token.length < 24) throw new SettingsError('DOCUBASE_ADMIN_TOKEN is required and must be at least 24 characters. Generate one with: openssl rand -base64 32');

  let masterKey;
  try {
    masterKey = parseMasterKey(env.DOCUBASE_MASTER_KEY);
  } catch (error) {
    throw new SettingsError(`DOCUBASE_MASTER_KEY: ${error.message}`);
  }

  const baseDomain = String(env.DOCUBASE_BASE_DOMAIN || '').trim().toLowerCase().replace(/\.$/, '');
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(baseDomain)) {
    throw new SettingsError('DOCUBASE_BASE_DOMAIN is required, for example docs.example.com. Sites are served at <name>.<that domain>.');
  }

  // Optional. When set, the admin API answers only on this hostname, so a reverse proxy can expose
  // customer sites publicly and keep the API on a name of its own.
  const adminHost = String(env.DOCUBASE_ADMIN_HOST || '').trim().toLowerCase().replace(/\.$/, '') || null;
  if (adminHost && !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(adminHost)) throw new SettingsError('DOCUBASE_ADMIN_HOST must be a hostname such as admin.docs.example.com');

  // The dashboard is a web app for people who sign in with an email and password. It answers on its own
  // hostname, app.<base domain> unless set, and "off" leaves only the admin API.
  const dashboardRaw = String(env.DOCUBASE_DASHBOARD_HOST ?? '').trim().toLowerCase().replace(/\.$/, '');
  const dashboardHost = dashboardRaw === 'off' ? null : dashboardRaw || `app.${baseDomain}`;
  if (dashboardHost && !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(dashboardHost)) throw new SettingsError('DOCUBASE_DASHBOARD_HOST must be a hostname such as app.docs.example.com, or off');
  if (dashboardHost && dashboardHost === adminHost) throw new SettingsError('DOCUBASE_DASHBOARD_HOST and DOCUBASE_ADMIN_HOST must be different hostnames');

  const signup = String(env.DOCUBASE_SIGNUP || 'closed').trim().toLowerCase();
  if (!['open', 'closed'].includes(signup)) throw new SettingsError('DOCUBASE_SIGNUP must be open or closed');

  // Billing for the paid plan. Paystack is used whenever its keys are set. Stripe is kept ready but
  // stays off until DOCUBASE_BILLING=stripe, so its keys can be filled in ahead of time. Without a
  // provider there are no plans.
  const paystack = {
    secretKey: String(env.PAYSTACK_SECRET_KEY || '').trim() || null,
    planCode: String(env.PAYSTACK_PLAN_CODE || '').trim() || null,
  };
  const paystackSet = Object.values(paystack).filter(Boolean).length;
  if (paystackSet === 1) throw new SettingsError('Billing with Paystack needs PAYSTACK_SECRET_KEY and PAYSTACK_PLAN_CODE together. Set both, or neither.');
  if (paystack.secretKey && !/^sk_(test|live)_[A-Za-z0-9]{20,}$/.test(paystack.secretKey)) throw new SettingsError('PAYSTACK_SECRET_KEY does not look like a Paystack secret key (sk_test_... or sk_live_...)');
  if (paystack.planCode && !/^PLN_[A-Za-z0-9]{6,}$/.test(paystack.planCode)) throw new SettingsError('PAYSTACK_PLAN_CODE must be a Paystack plan code such as PLN_abc123');

  const stripe = {
    secretKey: String(env.STRIPE_SECRET_KEY || '').trim() || null,
    priceId: String(env.STRIPE_PRICE_ID || '').trim() || null,
    webhookSecret: String(env.STRIPE_WEBHOOK_SECRET || '').trim() || null,
  };
  const stripeSet = Object.values(stripe).filter(Boolean).length;
  if (stripeSet > 0 && stripeSet < 3) throw new SettingsError('Billing with Stripe needs STRIPE_SECRET_KEY, STRIPE_PRICE_ID and STRIPE_WEBHOOK_SECRET together. Set all three, or none.');
  if (stripe.secretKey && !/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(stripe.secretKey)) throw new SettingsError('STRIPE_SECRET_KEY does not look like a Stripe secret key (sk_test_... or sk_live_...)');
  if (stripe.priceId && !/^price_[A-Za-z0-9]{6,}$/.test(stripe.priceId)) throw new SettingsError('STRIPE_PRICE_ID must be a Stripe price id such as price_1Abc...');
  if (stripe.webhookSecret && !/^whsec_[A-Za-z0-9]{10,}$/.test(stripe.webhookSecret)) throw new SettingsError('STRIPE_WEBHOOK_SECRET must be a Stripe webhook signing secret (whsec_...)');

  const choice = String(env.DOCUBASE_BILLING || '').trim().toLowerCase();
  if (choice && !['paystack', 'stripe', 'off'].includes(choice)) throw new SettingsError('DOCUBASE_BILLING must be paystack, stripe or off');
  let provider = null;
  if (choice === 'stripe') {
    if (stripeSet !== 3) throw new SettingsError('DOCUBASE_BILLING=stripe needs STRIPE_SECRET_KEY, STRIPE_PRICE_ID and STRIPE_WEBHOOK_SECRET');
    provider = 'stripe';
  } else if (choice === 'paystack' || (choice === '' && paystackSet === 2)) {
    if (paystackSet !== 2) throw new SettingsError('DOCUBASE_BILLING=paystack needs PAYSTACK_SECRET_KEY and PAYSTACK_PLAN_CODE');
    provider = 'paystack';
  }
  const billing = { provider, paystack, stripe };

  return {
    adminHost,
    dashboardHost,
    signup,
    billing,
    userMaxSites: int(env, 'DOCUBASE_USER_MAX_SITES', 3, 1, 10000),
    freePlanSites: int(env, 'DOCUBASE_FREE_SITES', 1, 0, 10000),
    proPlanSites: int(env, 'DOCUBASE_PRO_SITES', 10, 1, 10000),
    adminToken: token,
    masterKey,
    baseDomain,
    dataDir: path.resolve(env.DOCUBASE_DATA_DIR || './data'),
    port: int(env, 'PORT', 8080, 0, 65535),
    host: env.HOST || '127.0.0.1',
    publicUrl: env.DOCUBASE_PUBLIC_URL ? String(env.DOCUBASE_PUBLIC_URL).replace(/\/+$/, '') : null,
    trustProxy: env.DOCUBASE_TRUST_PROXY === '1' || env.DOCUBASE_TRUST_PROXY === 'true',
    maxSites: int(env, 'DOCUBASE_MAX_SITES', 50, 1, 100000),
    buildConcurrency: int(env, 'DOCUBASE_BUILD_CONCURRENCY', 2, 1, 16),
    buildTimeoutSeconds: int(env, 'DOCUBASE_BUILD_TIMEOUT_SECONDS', 120, 10, 3600),
    maxRepoMegabytes: int(env, 'DOCUBASE_MAX_DOCS_MB', 50, 1, 2000),
    maxFiles: int(env, 'DOCUBASE_MAX_FILES', 5000, 10, 200000),
    allowFileRepos: false, // only tests turn this on, through the API, never the environment
  };
}
