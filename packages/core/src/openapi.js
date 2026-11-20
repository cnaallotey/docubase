import { readFile } from 'node:fs/promises';
import path from 'node:path';
import GithubSlugger from 'github-slugger';
import YAML from 'yaml';
import { DocubaseError, squash } from './util.js';

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];
const MAX_DEPTH = 6;

/* ------------------------------------------------------------------ loading */

/** Read and parse an OpenAPI 3 file (YAML or JSON) from inside the docs folder. */
export async function loadSpec(root, specPath) {
  const abs = path.resolve(root, specPath);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new DocubaseError('docubase.config.json: "openapi.spec" must be a path inside the docs folder');
  }
  let raw;
  try {
    raw = await readFile(abs, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new DocubaseError(`docubase.config.json: openapi.spec file not found: ${specPath}`);
    throw error;
  }
  let doc;
  try {
    doc = YAML.parse(raw); // YAML parses JSON too. The parser never runs code.
  } catch (error) {
    throw new DocubaseError(`${specPath}: could not parse the file (${error.message.split('\n')[0]})`);
  }
  if (!doc || typeof doc !== 'object') throw new DocubaseError(`${specPath}: the file is empty or is not an OpenAPI document`);
  if (doc.swagger) throw new DocubaseError(`${specPath}: Swagger 2.0 is not supported. Convert the file to OpenAPI 3 first.`);
  if (typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.')) {
    throw new DocubaseError(`${specPath}: expected an OpenAPI 3.x document with a top level "openapi: 3.x" field`);
  }
  if (!doc.paths || typeof doc.paths !== 'object') throw new DocubaseError(`${specPath}: the document has no "paths"`);
  return doc;
}

/* ---------------------------------------------------------------- resolving */

class Resolver {
  constructor(doc, warn) {
    this.doc = doc;
    this.warn = warn;
    this.warned = new Set();
  }

  pointer(ref) {
    const parts = ref.slice(2).split('/').map((p) => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'));
    let cur = this.doc;
    for (const part of parts) {
      if (cur === null || typeof cur !== 'object' || !(part in cur)) return undefined;
      cur = cur[part];
    }
    return cur;
  }

  /** Follow $ref chains. `stack` holds the references already being expanded, to stop loops. */
  ref(node, stack = []) {
    let cur = node;
    let name = null;
    const seen = [...stack];
    while (cur && typeof cur === 'object' && typeof cur.$ref === 'string') {
      const ref = cur.$ref;
      if (!ref.startsWith('#/')) {
        if (!this.warned.has(ref)) {
          this.warned.add(ref);
          this.warn(`The reference "${ref}" points outside the spec file and was not followed.`);
        }
        return { node: { description: `External reference ${ref}` }, name: ref.split('/').at(-1) || ref, recursive: false, seen };
      }
      if (seen.includes(ref)) return { node: {}, name: ref.split('/').at(-1), recursive: true, seen };
      seen.push(ref);
      name = ref.split('/').at(-1);
      cur = this.pointer(ref);
      if (cur === undefined) {
        if (!this.warned.has(ref)) {
          this.warned.add(ref);
          this.warn(`The reference "${ref}" does not exist in the spec.`);
        }
        return { node: {}, name, recursive: false, seen };
      }
    }
    return { node: cur ?? {}, name, recursive: false, seen };
  }
}

/** Resolve a schema and merge allOf parts into one object schema. */
function normalize(schema, r, stack = []) {
  const res = r.ref(schema, stack);
  if (res.recursive) return { s: { type: 'object' }, name: res.name, recursive: true, stack: res.seen };
  let s = res.node;
  if (Array.isArray(s.allOf)) {
    const merged = { ...s, properties: { ...(s.properties || {}) }, required: [...(s.required || [])] };
    delete merged.allOf;
    for (const part of s.allOf) {
      const p = normalize(part, r, res.seen).s;
      Object.assign(merged.properties, p.properties || {});
      merged.required.push(...(p.required || []));
      for (const key of ['type', 'description', 'format', 'enum', 'items', 'example', 'default', 'additionalProperties']) {
        if (merged[key] === undefined && p[key] !== undefined) merged[key] = p[key];
      }
    }
    if (!merged.type && Object.keys(merged.properties).length > 0) merged.type = 'object';
    s = merged;
  }
  return { s, name: res.name, recursive: false, stack: res.seen };
}

/* ------------------------------------------------------------ text helpers */

/** Escape text that goes into a Markdown heading, table cell or inline position. */
function inline(text) {
  return squash(String(text ?? ''))
    .replace(/\\/g, '\\\\')
    .replace(/([`*_[\]|])/g, '\\$1')
    .replace(/</g, '&lt;');
}

function slugify(text) {
  const s = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'endpoints';
}

function shortName(schema, r, stack) {
  const n = normalize(schema, r, stack);
  return n.name ?? typeLabel(n.s, null, r, n.stack);
}

function typeLabel(s, name, r, stack) {
  if (s.oneOf || s.anyOf) {
    const list = (s.oneOf || s.anyOf).map((x) => shortName(x, r, stack));
    return `${s.oneOf ? 'one of' : 'any of'}: ${list.join(' | ')}`;
  }
  let t = Array.isArray(s.type) ? s.type.filter((x) => x !== 'null').join(' or ') : s.type;
  const nullable = s.nullable === true || (Array.isArray(s.type) && s.type.includes('null'));
  if (!t) t = s.properties ? 'object' : s.enum ? typeof s.enum[0] : 'any';
  if (t === 'array') t = `array of ${s.items ? shortName(s.items, r, stack) : 'any'}`;
  else if (t === 'object') {
    if (name) t = name;
    else if (s.additionalProperties && typeof s.additionalProperties === 'object') t = `map of ${shortName(s.additionalProperties, r, stack)}`;
  } else if (s.format) t = `${t} (${s.format})`;
  return nullable ? `${t}, nullable` : t;
}

function describe(s) {
  const parts = [];
  if (s.description) parts.push(squash(s.description));
  if (Array.isArray(s.enum)) parts.push(`One of: ${s.enum.map((v) => `\`${String(v)}\``).join(', ')}.`);
  if (s.default !== undefined) parts.push(`Default: \`${typeof s.default === 'object' ? JSON.stringify(s.default) : String(s.default)}\`.`);
  if (s.deprecated) parts.push('Deprecated.');
  return parts.join(' ');
}

function cell(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/</g, '&lt;');
}

/* ------------------------------------------------------------- schema rows */

function schemaRows(schema, r, stack = []) {
  const rows = [];

  function addProps(s, prefix, st, depth) {
    if (depth > MAX_DEPTH) return;
    for (const [key, prop] of Object.entries(s.properties || {})) {
      const pn = normalize(prop, r, st);
      rows.push({
        name: prefix + key,
        type: typeLabel(pn.s, pn.name, r, pn.stack),
        required: (s.required || []).includes(key),
        description: describe(pn.s),
      });
      if (pn.recursive) continue;
      if (pn.s.properties) addProps(pn.s, `${prefix}${key}.`, pn.stack, depth + 1);
      else if (pn.s.type === 'array' && pn.s.items) {
        const item = normalize(pn.s.items, r, pn.stack);
        if (!item.recursive && item.s.properties) addProps(item.s, `${prefix}${key}[].`, item.stack, depth + 1);
      }
    }
  }

  const root = normalize(schema, r, stack);
  if (root.recursive) return rows;
  if (root.s.properties) addProps(root.s, '', root.stack, 0);
  else if (root.s.type === 'array' && root.s.items) {
    const item = normalize(root.s.items, r, root.stack);
    if (!item.recursive && item.s.properties) addProps(item.s, '[].', item.stack, 0);
  }
  return rows;
}

const FORMAT_EXAMPLES = {
  'date-time': '2024-01-01T00:00:00Z',
  date: '2024-01-01',
  time: '12:00:00',
  email: 'user@example.com',
  uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  uri: 'https://example.com',
  url: 'https://example.com',
  hostname: 'example.com',
  ipv4: '192.0.2.1',
};

function exampleFor(schema, r, stack = [], depth = 0) {
  const n = normalize(schema, r, stack);
  const s = n.s;
  if (n.recursive || depth > MAX_DEPTH) return null;
  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.examples) && s.examples.length > 0) return s.examples[0];
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  if (s.oneOf || s.anyOf) return exampleFor((s.oneOf || s.anyOf)[0], r, n.stack, depth + 1);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  if (type === 'object' || s.properties) {
    const out = {};
    for (const [key, prop] of Object.entries(s.properties || {})) out[key] = exampleFor(prop, r, n.stack, depth + 1);
    return out;
  }
  if (type === 'array') return s.items ? [exampleFor(s.items, r, n.stack, depth + 1)] : [];
  if (type === 'string') return FORMAT_EXAMPLES[s.format] ?? 'string';
  if (type === 'integer' || type === 'number') return typeof s.minimum === 'number' ? s.minimum : 0;
  if (type === 'boolean') return true;
  return null;
}

function pickMedia(content) {
  const types = Object.keys(content || {});
  if (types.length === 0) return null;
  const type = types.find((t) => t === 'application/json') ?? types.find((t) => /json/i.test(t)) ?? types[0];
  return { type, media: content[type], all: types };
}

function mediaExample(media, r) {
  if (!media) return undefined;
  if (media.example !== undefined) return media.example;
  if (media.examples && typeof media.examples === 'object') {
    const first = Object.values(media.examples)[0];
    if (first) {
      const resolved = r.ref(first).node;
      if (resolved.value !== undefined) return resolved.value;
    }
  }
  if (media.schema) return exampleFor(media.schema, r);
  return undefined;
}

/* ---------------------------------------------------------------- security */

function securityFor(operation, doc, r) {
  const requirements = operation.security ?? doc.security ?? [];
  if (requirements.length === 0) return { kind: 'none', names: [] };
  const first = requirements[0] || {};
  const names = Object.keys(first);
  if (names.length === 0) return { kind: 'none', names: [] };
  const scheme = r.ref(doc.components?.securitySchemes?.[names[0]] ?? {}).node;
  const base = { names, scheme: names[0] };
  if (scheme.type === 'http' && /^basic$/i.test(scheme.scheme)) return { ...base, kind: 'basic' };
  if (scheme.type === 'http') return { ...base, kind: 'bearer' };
  if (scheme.type === 'oauth2' || scheme.type === 'openIdConnect') return { ...base, kind: 'bearer' };
  if (scheme.type === 'apiKey' && (scheme.in === 'header' || scheme.in === 'query')) {
    return { ...base, kind: 'apiKey', in: scheme.in, name: String(scheme.name || '') };
  }
  return { ...base, kind: 'none' };
}

function describeScheme(name, scheme) {
  if (scheme.type === 'http' && /^bearer$/i.test(scheme.scheme)) return `HTTP bearer token. Send \`Authorization: Bearer <token>\`.`;
  if (scheme.type === 'http' && /^basic$/i.test(scheme.scheme)) return 'HTTP basic authentication with a username and password.';
  if (scheme.type === 'apiKey') return `API key sent in the ${scheme.in} named \`${scheme.name}\`.`;
  if (scheme.type === 'oauth2') return 'OAuth 2.0. Send the access token as `Authorization: Bearer <token>`.';
  if (scheme.type === 'openIdConnect') return 'OpenID Connect. Send the access token as `Authorization: Bearer <token>`.';
  return `${scheme.type || 'Custom'} authentication.`;
}

/* ------------------------------------------------------------------ servers */

function resolveServers(list) {
  const urls = [];
  const hints = [];
  for (const server of list || []) {
    if (!server || typeof server.url !== 'string') continue;
    let url = server.url;
    for (const [key, variable] of Object.entries(server.variables || {})) {
      url = url.replaceAll(`{${key}}`, String(variable?.default ?? ''));
    }
    if (/^https?:\/\//i.test(url)) urls.push(url.replace(/\/+$/, ''));
    else hints.push(url);
  }
  return { urls, hints };
}

/* --------------------------------------------------------------- generating */

function frontmatter(data) {
  return `---\n${YAML.stringify(data)}---\n\n`;
}

function bodyFence(example) {
  return `\`\`\`json\n${JSON.stringify(example, null, 2)}\n\`\`\``;
}

function fieldTable(rows) {
  if (rows.length === 0) return '';
  const lines = ['| Field | Type | Required | Description |', '| --- | --- | --- | --- |'];
  for (const row of rows) {
    lines.push(`| \`${cell(row.name)}\` | ${cell(row.type)} | ${row.required ? 'yes' : 'no'} | ${cell(row.description)} |`);
  }
  return lines.join('\n');
}

function collectParameters(pathItem, operation, r) {
  const merged = new Map();
  for (const raw of [...(pathItem.parameters || []), ...(operation.parameters || [])]) {
    const p = r.ref(raw).node;
    if (!p || typeof p.name !== 'string' || typeof p.in !== 'string') continue;
    merged.set(`${p.in}:${p.name}`, p);
  }
  const order = { path: 0, query: 1, header: 2, cookie: 3 };
  return [...merged.values()].sort((a, b) => (order[a.in] ?? 9) - (order[b.in] ?? 9));
}

/** Only prefill a parameter with a value the spec itself gives. A made up placeholder would be sent as real data. */
function paramExample(p, r) {
  if (p.example !== undefined) return String(p.example);
  if (!p.schema) return '';
  const s = normalize(p.schema, r).s;
  const given = s.example !== undefined ? s.example : s.default !== undefined ? s.default : Array.isArray(s.enum) ? s.enum[0] : undefined;
  return given !== undefined && given !== null && typeof given !== 'object' ? String(given) : '';
}

/** Turn an example into text for the playground body box. */
function bodyText(type, example) {
  if (example === undefined) return '';
  if (/json/i.test(type)) return JSON.stringify(example, null, 2);
  if (type === 'application/x-www-form-urlencoded' && example && typeof example === 'object' && !Array.isArray(example)) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(example)) params.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    return params.toString();
  }
  if (typeof example === 'string') return example;
  return '';
}

function buildOperation({ method, route, operation, pathItem, doc, r, heading, operations }) {
  const out = [];
  const title = operation.summary || operation.operationId || `${method.toUpperCase()} ${route}`;
  heading(2, title, out);
  out.push(`**\`${method.toUpperCase()}\`** \`${route}\``);
  if (operation.deprecated) out.push(':::warning[Deprecated]\nThis endpoint is deprecated.\n:::');
  if (operation.description) out.push(String(operation.description).trim());

  const params = collectParameters(pathItem, operation, r);
  if (params.length > 0) {
    heading(4, 'Parameters', out);
    const lines = ['| Name | In | Type | Required | Description |', '| --- | --- | --- | --- | --- |'];
    for (const p of params) {
      const sn = p.schema ? normalize(p.schema, r) : { s: {}, name: null, stack: [] };
      const type = p.schema ? typeLabel(sn.s, sn.name, r, sn.stack) : 'any';
      const desc = [p.description ? squash(p.description) : '', p.schema ? describe({ enum: sn.s.enum, default: sn.s.default }) : ''].filter(Boolean).join(' ');
      lines.push(`| \`${cell(p.name)}\` | ${p.in} | ${cell(type)} | ${p.required || p.in === 'path' ? 'yes' : 'no'} | ${cell(desc)} |`);
    }
    out.push(lines.join('\n'));
  }

  let body = null;
  const requestBody = operation.requestBody ? r.ref(operation.requestBody).node : null;
  if (requestBody && requestBody.content) {
    const picked = pickMedia(requestBody.content);
    if (picked) {
      heading(4, 'Request body', out);
      const bits = [`Content type: \`${picked.type}\`${requestBody.required ? ' (required)' : ''}.`];
      if (picked.all.length > 1) bits.push(`Also accepts: ${picked.all.filter((t) => t !== picked.type).map((t) => `\`${t}\``).join(', ')}.`);
      if (requestBody.description) bits.push(squash(requestBody.description));
      out.push(bits.join(' '));
      if (picked.media?.schema) out.push(fieldTable(schemaRows(picked.media.schema, r)));
      const example = mediaExample(picked.media, r);
      if (example !== undefined && /json/i.test(picked.type)) out.push(bodyFence(example));
      body = { contentType: picked.type, text: bodyText(picked.type, example), supported: !/multipart/i.test(picked.type), required: Boolean(requestBody.required) };
    }
  }

  const responses = Object.entries(operation.responses || {});
  if (responses.length > 0) {
    heading(4, 'Responses', out);
    for (const [status, raw] of responses) {
      const resp = r.ref(raw).node;
      const picked = pickMedia(resp.content);
      out.push(`**${cell(status)}** ${resp.description ? cell(resp.description) : ''}${picked ? ` (\`${picked.type}\`)` : ''}`.trim());
      if (picked && /^2/.test(status) && picked.media?.schema) out.push(fieldTable(schemaRows(picked.media.schema, r)));
      if (picked && /json/i.test(picked.type)) {
        const explicit = mediaExample(picked.media, r);
        const example = /^2/.test(status) ? explicit : picked.media?.example !== undefined || picked.media?.examples ? explicit : undefined;
        if (example !== undefined) out.push(bodyFence(example));
      }
    }
  }

  const security = securityFor(operation, doc, r);
  if (security.names.length > 0) out.push(`Authentication: ${security.names.map((n) => `\`${n}\``).join(', ')}.`);

  const servers = resolveServers(operation.servers ?? pathItem.servers ?? doc.servers);
  const index = operations.length;
  operations.push({
    title,
    method: method.toUpperCase(),
    path: route,
    servers: servers.urls,
    serverHints: servers.hints,
    parameters: params
      .filter((p) => ['path', 'query', 'header'].includes(p.in))
      .map((p) => ({ name: p.name, in: p.in, required: Boolean(p.required || p.in === 'path'), example: paramExample(p, r) })),
    body,
    security,
  });
  out.push(`::try-it{n=${index}}`);
  return out.join('\n\n');
}

/**
 * Generate Markdown pages from an OpenAPI document: an overview and one page per tag.
 * Pages are plain Markdown so navigation, search, llms.txt and the assistant treat them like any other page.
 *
 * @param {object} options
 * @param {object} options.doc parsed OpenAPI document
 * @param {{ path: string, title: string, order: number }} options.openapi config section
 * @param {(source: string, raw: string) => Promise<object>} options.compile turns Markdown into a page
 * @returns {Promise<{ pages: object[], warnings: string[] }>}
 */
export async function buildApiPages({ doc, openapi, compile }) {
  const warnings = [];
  const r = new Resolver(doc, (message) => warnings.push(`${openapi.spec ?? 'openapi'}: ${message}`));
  const info = doc.info || {};

  // Group operations by tag, keeping the order of the spec.
  const tagOrder = [];
  const tagInfo = new Map();
  for (const tag of doc.tags || []) {
    if (tag && typeof tag.name === 'string') {
      tagOrder.push(tag.name);
      tagInfo.set(tag.name, tag);
    }
  }
  const byTag = new Map();
  for (const [route, rawItem] of Object.entries(doc.paths)) {
    const pathItem = r.ref(rawItem).node;
    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== 'object') continue;
      const tag = (Array.isArray(operation.tags) && operation.tags[0]) || 'Endpoints';
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push({ method, route, operation, pathItem });
      if (!tagOrder.includes(tag)) tagOrder.push(tag);
    }
  }
  const tags = tagOrder.filter((t) => byTag.has(t));
  if (tags.length === 0) throw new DocubaseError(`${openapi.spec ?? 'openapi'}: the document has no operations`);

  // Unique page names per tag.
  const slugs = new Map();
  const used = new Set(['index']);
  for (const tag of tags) {
    let slug = slugify(tag);
    let n = 2;
    while (used.has(slug)) slug = `${slugify(tag)}-${n++}`;
    used.add(slug);
    slugs.set(tag, slug);
  }

  const pages = [];
  const overviewRows = [];

  for (const [i, tag] of tags.entries()) {
    const slugger = new GithubSlugger();
    const operations = [];
    const blocks = [];
    const tagMeta = tagInfo.get(tag);
    if (tagMeta?.description) blocks.push(String(tagMeta.description).trim());

    const heading = (level, text, out) => {
      const id = slugger.slug(squash(text));
      out.push(`${'#'.repeat(level)} ${inline(text)}`);
      return id;
    };

    for (const entry of byTag.get(tag)) {
      const out = [];
      const headingOut = [];
      const title = entry.operation.summary || entry.operation.operationId || `${entry.method.toUpperCase()} ${entry.route}`;
      // The h2 id is read from the same slugger the page uses, so links from the overview match.
      const trackedHeading = (level, text, sink) => {
        const id = heading(level, text, sink);
        if (level === 2) headingOut.push(id);
        return id;
      };
      const markdown = buildOperation({ ...entry, doc, r, heading: trackedHeading, operations });
      out.push(markdown);
      blocks.push(out.join('\n\n'));
      overviewRows.push({ method: entry.method.toUpperCase(), route: entry.route, title, slug: slugs.get(tag), anchor: headingOut[0] });
    }

    const description = tagMeta?.description ? squash(tagMeta.description) : `${operations.length} endpoint${operations.length === 1 ? '' : 's'}`;
    const raw = frontmatter({ title: tag, description, order: i + 1 }) + blocks.join('\n\n') + '\n';
    const page = await compile(`${openapi.path}/${slugs.get(tag)}.md`, raw);
    page.generated = true;
    page.api = { operations };
    pages.push(page);
  }

  // Overview page.
  const intro = [];
  if (info.description) intro.push(String(info.description).trim());
  const rootServers = resolveServers(doc.servers);
  if (rootServers.urls.length > 0 || rootServers.hints.length > 0) {
    intro.push('## Base URLs');
    intro.push([...rootServers.urls, ...rootServers.hints].map((u) => `* \`${u.replace(/`/g, '')}\``).join('\n'));
  }
  const schemes = Object.entries(doc.components?.securitySchemes || {});
  if (schemes.length > 0) {
    intro.push('## Authentication');
    intro.push(schemes.map(([name, raw]) => `* \`${name.replace(/`/g, '')}\`: ${describeScheme(name, r.ref(raw).node)}`).join('\n'));
  }
  intro.push('## Endpoints');
  const table = ['| Method | Path | Summary |', '| --- | --- | --- |'];
  for (const row of overviewRows) {
    table.push(`| \`${row.method}\` | \`${cell(row.route)}\` | [${inline(row.title)}](./${row.slug}.md#${row.anchor}) |`);
  }
  intro.push(table.join('\n'));
  const overviewTitle = info.title ? String(info.title) : 'API overview';
  const overview = await compile(
    `${openapi.path}/index.md`,
    frontmatter({ title: overviewTitle, description: info.version ? `Version ${info.version}` : 'API overview', order: 0 }) + intro.join('\n\n') + '\n',
  );
  overview.generated = true;
  overview.api = { operations: [] };

  return { pages: [overview, ...pages], warnings };
}
