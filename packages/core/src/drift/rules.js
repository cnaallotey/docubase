/** Every drift rule and its default level. "off" turns a rule off, "warn" reports it, "error" fails the check. */
export const RULES = {
  'missing-file': 'error',
  'missing-script': 'error',
  'missing-flag': 'error',
  'missing-env': 'warn',
  'missing-symbol': 'warn',
  'unknown-endpoint': 'error',
  'invalid-json': 'error',
  'invalid-yaml': 'error',
  stale: 'warn',
  'covers-no-match': 'error',
  'external-link': 'warn',
};

export const LEVELS = ['error', 'warn', 'off'];
