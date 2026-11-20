import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DocubaseError } from './util.js';
import { LEVELS, RULES } from './drift/rules.js';

export const CONFIG_FILE = 'docubase.config.json';

export const DEFAULTS = {
  title: 'Docs',
  description: '',
  lang: 'en',
  base: '/',
  outDir: 'dist',
  links: [],
  editUrl: null,
  footer: '',
  sidebar: null,
  siteUrl: null,
  socialImage: null,
  twitter: null,
  openapi: null,
  assistant: {
    enabled: false,
    provider: 'anthropic',
    model: null,
    baseUrl: null,
    endpoint: null,
    rateLimitPerMinute: 20,
    maxQuestionLength: 500,
    allowedOrigins: [],
    trustProxy: false,
  },
  blog: { enabled: false },
  mcp: {
    enabled: false,
    rateLimitPerMinute: 120,
    allowedOrigins: [],
    trustProxy: false,
  },
  drift: {
    repo: null,
    ignore: [],
    ignoreTokens: [],
    rules: {},
    baseline: null,
    external: { ignore: [], timeoutMs: 8000 },
  },
  theme: { accent: '#2f5d46' },
};

function fail(message) {
  throw new DocubaseError(`${CONFIG_FILE}: ${message}`);
}

function expectString(value, key) {
  if (typeof value !== 'string') fail(`"${key}" must be a string`);
  return value;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A social image: a full http(s) URL, a path from the site root ("/og.png") or a path inside the docs
 * output ("images/og.png"). It may contain {page}, replaced by the page path ("index" for the start page).
 * Exported so frontmatter "image" follows the same rules.
 */
export function normalizeImage(value, key, raise) {
  if (typeof value !== 'string' || !value.trim()) raise(`"${key}" must be a URL or a path to an image`);
  const image = value.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(image)) {
    if (!isHttpUrl(image.replaceAll('{page}', 'index'))) raise(`"${key}" must be an http(s) URL or a path such as /og.png`);
    return image;
  }
  if (image.startsWith('//') || image.split(/[\\/]/).includes('..') || /["<>\s]/.test(image)) raise(`"${key}" must be a path inside the site, such as /og.png`);
  return image;
}

function normalizeOpenApi(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('"openapi" must be an object such as { "spec": "openapi.yaml" }');
  const spec = expectString(value.spec, 'openapi.spec').trim();
  if (!spec) fail('"openapi.spec" is required');
  if (path.isAbsolute(spec) || spec.split(/[\\/]/).includes('..')) fail('"openapi.spec" must be a path inside the docs folder');
  const base = value.path === undefined ? 'api' : expectString(value.path, 'openapi.path').replace(/^\/+|\/+$/g, '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(base)) fail('"openapi.path" may only contain letters, numbers, dashes, underscores and slashes');
  const title = value.title === undefined ? 'API reference' : expectString(value.title, 'openapi.title');
  const order = value.order === undefined ? 4 : value.order;
  if (typeof order !== 'number' || Number.isNaN(order)) fail('"openapi.order" must be a number');
  return { spec, path: base, title, order };
}

function normalizeAssistant(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('"assistant" must be an object');
  for (const key of Object.keys(value)) {
    if (/key|secret|token|password/i.test(key)) {
      fail(`"assistant.${key}" is not allowed. Never put keys in this file. Set the ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable instead.`);
    }
  }
  const out = { ...DEFAULTS.assistant, allowedOrigins: [] };
  if ('enabled' in value) {
    if (typeof value.enabled !== 'boolean') fail('"assistant.enabled" must be true or false');
    out.enabled = value.enabled;
  }
  if ('provider' in value) {
    if (!['anthropic', 'openai'].includes(value.provider)) fail('"assistant.provider" must be "anthropic" or "openai" (use "openai" for any OpenAI compatible server such as Ollama)');
    out.provider = value.provider;
  }
  if ('model' in value && value.model !== null) out.model = expectString(value.model, 'assistant.model').trim();
  if (out.enabled && !out.model) fail('"assistant.model" is required when the assistant is enabled. Use a model name your provider offers.');
  if ('baseUrl' in value && value.baseUrl !== null) {
    const url = expectString(value.baseUrl, 'assistant.baseUrl');
    if (!isHttpUrl(url)) fail('"assistant.baseUrl" must be an http or https URL');
    out.baseUrl = url.replace(/\/+$/, '');
  }
  if ('endpoint' in value && value.endpoint !== null) {
    const endpoint = expectString(value.endpoint, 'assistant.endpoint');
    if (!endpoint.startsWith('/') && !isHttpUrl(endpoint)) fail('"assistant.endpoint" must start with / or be a full http(s) URL');
    out.endpoint = endpoint;
  }
  if ('rateLimitPerMinute' in value) {
    const n = value.rateLimitPerMinute;
    if (!Number.isInteger(n) || n < 1 || n > 600) fail('"assistant.rateLimitPerMinute" must be a whole number from 1 to 600');
    out.rateLimitPerMinute = n;
  }
  if ('maxQuestionLength' in value) {
    const n = value.maxQuestionLength;
    if (!Number.isInteger(n) || n < 20 || n > 2000) fail('"assistant.maxQuestionLength" must be a whole number from 20 to 2000');
    out.maxQuestionLength = n;
  }
  if ('allowedOrigins' in value) {
    if (!Array.isArray(value.allowedOrigins)) fail('"assistant.allowedOrigins" must be a list of origins such as https://example.com');
    out.allowedOrigins = value.allowedOrigins.map((origin) => {
      if (typeof origin !== 'string' || !isHttpUrl(origin)) fail('"assistant.allowedOrigins" must contain http(s) origins such as https://example.com');
      return new URL(origin).origin;
    });
  }
  if ('trustProxy' in value) {
    if (typeof value.trustProxy !== 'boolean') fail('"assistant.trustProxy" must be true or false');
    out.trustProxy = value.trustProxy;
  }
  return out;
}

function normalizeBlog(value) {
  if (typeof value === 'boolean') return { enabled: value };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('"blog" must be true, false or { "enabled": true }');
  if ('enabled' in value && typeof value.enabled !== 'boolean') fail('"blog.enabled" must be true or false');
  return { enabled: value.enabled ?? true };
}

function normalizeMcp(value) {
  if (typeof value === 'boolean') return { ...DEFAULTS.mcp, enabled: value, allowedOrigins: [] };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('"mcp" must be an object, or true or false');
  const out = { ...DEFAULTS.mcp, allowedOrigins: [] };
  if ('enabled' in value) {
    if (typeof value.enabled !== 'boolean') fail('"mcp.enabled" must be true or false');
    out.enabled = value.enabled;
  }
  if ('rateLimitPerMinute' in value) {
    const n = value.rateLimitPerMinute;
    if (!Number.isInteger(n) || n < 1 || n > 6000) fail('"mcp.rateLimitPerMinute" must be a whole number from 1 to 6000');
    out.rateLimitPerMinute = n;
  }
  if ('allowedOrigins' in value) {
    if (!Array.isArray(value.allowedOrigins)) fail('"mcp.allowedOrigins" must be a list of origins such as https://example.com');
    for (const origin of value.allowedOrigins) {
      if (typeof origin !== 'string' || !isHttpUrl(origin)) fail('"mcp.allowedOrigins" must contain http(s) origins such as https://example.com');
    }
    out.allowedOrigins = [...value.allowedOrigins];
  }
  if ('trustProxy' in value) {
    if (typeof value.trustProxy !== 'boolean') fail('"mcp.trustProxy" must be true or false');
    out.trustProxy = value.trustProxy;
  }
  return out;
}

function stringList(value, key) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) fail(`"${key}" must be a list of non empty strings`);
  return value.map((v) => v.trim());
}

function insideProject(value, key) {
  if (path.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) fail(`"${key}" must be a relative path`);
}

function normalizeDrift(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('"drift" must be an object');
  const out = { ...DEFAULTS.drift, ignore: [], ignoreTokens: [], rules: {}, external: { ...DEFAULTS.drift.external, ignore: [] } };
  if ('repo' in value && value.repo !== null) {
    out.repo = expectString(value.repo, 'drift.repo').trim();
    insideProject(out.repo, 'drift.repo');
  }
  if ('ignore' in value) out.ignore = stringList(value.ignore, 'drift.ignore');
  if ('ignoreTokens' in value) out.ignoreTokens = stringList(value.ignoreTokens, 'drift.ignoreTokens');
  if ('baseline' in value && value.baseline !== null) {
    out.baseline = expectString(value.baseline, 'drift.baseline').trim();
    insideProject(out.baseline, 'drift.baseline');
  }
  if ('rules' in value) {
    const rules = value.rules;
    if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) fail('"drift.rules" must be an object such as { "stale": "off" }');
    for (const [name, level] of Object.entries(rules)) {
      if (!(name in RULES)) fail(`"drift.rules.${name}" is not a rule. Rules are: ${Object.keys(RULES).join(', ')}`);
      if (!LEVELS.includes(level)) fail(`"drift.rules.${name}" must be "error", "warn" or "off"`);
      out.rules[name] = level;
    }
  }
  if ('external' in value) {
    const ext = value.external;
    if (ext === null || typeof ext !== 'object' || Array.isArray(ext)) fail('"drift.external" must be an object');
    if ('ignore' in ext) out.external.ignore = stringList(ext.ignore, 'drift.external.ignore');
    if ('timeoutMs' in ext) {
      if (!Number.isInteger(ext.timeoutMs) || ext.timeoutMs < 500 || ext.timeoutMs > 60000) fail('"drift.external.timeoutMs" must be a whole number from 500 to 60000');
      out.external.timeoutMs = ext.timeoutMs;
    }
  }
  return out;
}

function normalizeBase(value) {
  let base = expectString(value, 'base').trim();
  if (!base.startsWith('/')) base = `/${base}`;
  if (!base.endsWith('/')) base = `${base}/`;
  return base;
}

/** Validate user config and merge it over the defaults. Throws DocubaseError with a clear message. */
export function normalizeConfig(user = {}) {
  if (user === null || typeof user !== 'object' || Array.isArray(user)) fail('must be a JSON object');

  const config = { ...DEFAULTS, theme: { ...DEFAULTS.theme } };

  if ('title' in user) config.title = expectString(user.title, 'title');
  if ('description' in user) config.description = expectString(user.description, 'description');
  if ('footer' in user) config.footer = expectString(user.footer, 'footer');
  if ('lang' in user) {
    config.lang = expectString(user.lang, 'lang');
    if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(config.lang)) fail('"lang" must be a language code such as en or pt-BR');
  }
  if ('base' in user) config.base = normalizeBase(user.base);
  if ('outDir' in user) {
    config.outDir = expectString(user.outDir, 'outDir');
    if (!config.outDir.trim()) fail('"outDir" cannot be empty');
  }

  if ('editUrl' in user && user.editUrl !== null) {
    const url = expectString(user.editUrl, 'editUrl');
    if (!/^https?:\/\//i.test(url)) fail('"editUrl" must start with http:// or https://');
    if (!url.includes('{path}')) fail('"editUrl" must contain {path}, for example https://github.com/you/repo/edit/main/docs/{path}');
    config.editUrl = url;
  }

  if ('links' in user) {
    if (!Array.isArray(user.links)) fail('"links" must be a list of { "label", "href" }');
    config.links = user.links.map((link, i) => {
      if (!link || typeof link.label !== 'string' || typeof link.href !== 'string') {
        fail(`"links[${i}]" needs a string "label" and a string "href"`);
      }
      if (/^\s*javascript:/i.test(link.href)) fail(`"links[${i}].href" cannot be a javascript: URL`);
      return { label: link.label, href: link.href };
    });
  }

  if ('theme' in user) {
    const theme = user.theme;
    if (theme === null || typeof theme !== 'object' || Array.isArray(theme)) fail('"theme" must be an object');
    if ('accent' in theme) {
      // Only hex colours are accepted because the value is written into the page CSS.
      if (typeof theme.accent !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(theme.accent)) {
        fail('"theme.accent" must be a hex colour such as #2f5d46');
      }
      config.theme.accent = theme.accent;
    }
  }

  if ('siteUrl' in user && user.siteUrl !== null) {
    const url = expectString(user.siteUrl, 'siteUrl');
    if (!isHttpUrl(url)) fail('"siteUrl" must be a full http(s) URL such as https://docs.example.com');
    config.siteUrl = url.replace(/\/+$/, '');
  }
  if ('socialImage' in user && user.socialImage !== null) config.socialImage = normalizeImage(user.socialImage, 'socialImage', fail);
  if ('twitter' in user && user.twitter !== null) {
    const handle = expectString(user.twitter, 'twitter').trim();
    if (!/^@?[A-Za-z0-9_]{1,15}$/.test(handle)) fail('"twitter" must be an X (Twitter) handle such as @docubase');
    config.twitter = handle.startsWith('@') ? handle : `@${handle}`;
  }
  if ('openapi' in user && user.openapi !== null) config.openapi = normalizeOpenApi(user.openapi);
  if ('assistant' in user && user.assistant !== null) config.assistant = normalizeAssistant(user.assistant);
  if ('mcp' in user && user.mcp !== null) config.mcp = normalizeMcp(user.mcp);
  if ('blog' in user && user.blog !== null) config.blog = normalizeBlog(user.blog);
  if ('drift' in user && user.drift !== null) config.drift = normalizeDrift(user.drift);

  if ('sidebar' in user && user.sidebar !== null) {
    if (!Array.isArray(user.sidebar)) fail('"sidebar" must be a list');
    config.sidebar = user.sidebar;
  }

  return config;
}

/** Read docubase.config.json from the docs folder. A missing file means defaults. */
export async function loadConfig(root) {
  let raw;
  try {
    raw = await readFile(path.join(root, CONFIG_FILE), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return normalizeConfig({});
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`not valid JSON (${error.message})`);
  }
  return normalizeConfig(parsed);
}
