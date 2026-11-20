import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** The master key is 32 random bytes, written as 64 hex characters or as base64. */
export function parseMasterKey(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('is required. Generate one with: openssl rand -hex 32');
  const bytes = /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (bytes.length !== 32) throw new Error('must be 32 bytes, as 64 hex characters or base64. Generate one with: openssl rand -hex 32');
  return bytes;
}

/**
 * Encrypt a secret with AES-256-GCM. `context` (for example "site:ab12:assistant") is bound into the
 * ciphertext, so a stored value copied to another site or another purpose will not decrypt.
 */
export function seal(key, context, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function open(key, context, sealed) {
  const [version, iv, tag, body] = String(sealed).split('.');
  if (version !== 'v1' || !iv || !tag || body === undefined) throw new Error('Unrecognised secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

/** Compare two strings without leaking where they differ. Hashing first makes the lengths equal. */
export function safeEqual(a, b) {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
}

export function newSecret(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

/** GitHub signs the raw request body with the webhook secret and sends "sha256=<hex>". */
export function verifyGithubSignature(secret, rawBody, header) {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(String(header || ''));
  if (!match) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(match[1], 'hex'));
}
