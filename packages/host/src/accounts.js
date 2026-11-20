import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'docubase_session';

export class AccountError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) throw new AccountError(400, 'Enter a valid email address');
  return email;
}

export function checkPassword(value) {
  if (typeof value !== 'string' || value.length < 10) throw new AccountError(400, 'Use a password of at least 10 characters');
  if (value.length > 200) throw new AccountError(400, 'Use a password of at most 200 characters');
  return value;
}

/** scrypt with a random salt. The stored form names its parameters, so they can be raised later. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password, stored) {
  const [kind, n, r, p, salt, expected] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !expected) return false;
  const want = Buffer.from(expected, 'base64url');
  const got = await scrypt(String(password), Buffer.from(salt, 'base64url'), want.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A hash every login compares against when the email is unknown, so timing does not reveal who has an account. */
let decoy = null;
export async function decoyHash() {
  decoy ??= await hashPassword(randomBytes(16).toString('hex'));
  return decoy;
}

/** Session tokens are random. Only their SHA-256 is stored, so a copy of the database cannot be used to sign in. */
export function newSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function tokenId(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function readCookie(req, name) {
  const header = String(req.headers.cookie || '');
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

export function sessionCookie(token, { secure, maxAgeSeconds = SESSION_DAYS * 86400 }) {
  return [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`, ...(secure ? ['Secure'] : [])].join('; ');
}

export function clearedCookie({ secure }) {
  return sessionCookie('', { secure, maxAgeSeconds: 0 });
}

/** What the dashboard may know about a user. Never the password hash or billing secrets. */
export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt,
    plan: user.plan || 'free',
    subscription: user.billing?.status ?? null,
  };
}

/**
 * Count attempts per key in a sliding minute. Used for sign in and sign up, per address and per email,
 * so neither guessing one account from many addresses nor many accounts from one address gets far.
 */
export function createLimiter(limit, windowMs = 60000) {
  const hits = new Map();
  return {
    blocked(key) {
      const now = Date.now();
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      hits.set(key, recent);
      return recent.length >= limit;
    },
    record(key) {
      const now = Date.now();
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > 10000) hits.clear();
    },
    reset(key) {
      hits.delete(key);
    },
  };
}
