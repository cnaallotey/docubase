import { DocubaseError, prettify } from './util.js';

const DEFAULT_ORDER = 1000;

function item(page) {
  return { type: 'page', title: page.title, url: page.url, slug: page.slug };
}

function sortItems(items) {
  items.sort((a, b) => {
    if (a.isIndex !== b.isIndex) return a.isIndex ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    if (a.type !== b.type) return a.type === 'page' ? -1 : 1;
    return (a.title ?? a.label).localeCompare(b.title ?? b.label);
  });
  for (const entry of items) if (entry.type === 'group') sortItems(entry.items);
}

function strip(items) {
  return items.map((entry) => {
    if (entry.type === 'group') return { type: 'group', label: entry.label, items: strip(entry.items) };
    return { type: 'page', title: entry.title, url: entry.url, slug: entry.slug };
  });
}

function dropEmpty(items) {
  return items
    .map((entry) => (entry.type === 'group' ? { ...entry, items: dropEmpty(entry.items) } : entry))
    .filter((entry) => entry.type === 'page' || entry.items.length > 0);
}

/** Build the sidebar from the folder layout, frontmatter `order` and optional `_meta.json` files. */
function buildAuto(pages, metas) {
  const root = { items: [] };
  const groups = new Map();

  function ensureGroup(segments) {
    let parent = root;
    for (let i = 0; i < segments.length; i += 1) {
      const key = segments.slice(0, i + 1).join('/');
      let group = groups.get(key);
      if (!group) {
        const meta = metas.get(key) ?? {};
        group = {
          type: 'group',
          label: meta.label ?? prettify(segments[i]),
          order: typeof meta.order === 'number' ? meta.order : DEFAULT_ORDER,
          isIndex: false,
          items: [],
        };
        groups.set(key, group);
        parent.items.push(group);
      }
      parent = group;
    }
    return parent;
  }

  for (const page of pages) {
    if (page.hidden) continue;
    const segments = page.slug ? page.slug.split('/') : [];
    const dirSegments = page.isIndex ? segments : segments.slice(0, -1);
    const parent = ensureGroup(dirSegments);
    parent.items.push({ ...item(page), isIndex: page.isIndex, order: page.order ?? DEFAULT_ORDER });
  }

  sortItems(root.items);
  return dropEmpty(strip(root.items));
}

/** Build the sidebar from the "sidebar" list in docubase.config.json. */
function buildExplicit(sidebar, bySlug) {
  const missing = [];

  function resolve(entries) {
    const out = [];
    for (const entry of entries) {
      if (typeof entry === 'string') {
        const slug = entry === 'index' ? '' : entry.replace(/^\/|\/$/g, '');
        const page = bySlug.get(slug);
        if (!page) missing.push(entry);
        else out.push(item(page));
      } else if (entry && typeof entry === 'object' && Array.isArray(entry.items)) {
        out.push({ type: 'group', label: String(entry.group ?? entry.label ?? ''), items: resolve(entry.items) });
      } else if (entry && typeof entry === 'object' && typeof entry.slug === 'string') {
        const page = bySlug.get(entry.slug.replace(/^\/|\/$/g, ''));
        if (!page) missing.push(entry.slug);
        else out.push({ ...item(page), title: entry.label ?? page.title });
      } else {
        throw new DocubaseError('docubase.config.json: each "sidebar" entry must be a page path, { "slug", "label" } or { "group", "items" }');
      }
    }
    return out;
  }

  const tree = resolve(sidebar);
  if (missing.length > 0) {
    throw new DocubaseError(`docubase.config.json: "sidebar" refers to pages that do not exist: ${missing.join(', ')}`);
  }
  return tree;
}

function flatten(tree, out = []) {
  for (const entry of tree) {
    if (entry.type === 'page') out.push(entry);
    else flatten(entry.items, out);
  }
  return out;
}

/**
 * @param {Array} pages compiled pages
 * @param {{ sidebar: Array|null }} config
 * @param {Map<string, { label?: string, order?: number }>} metas folder settings keyed by folder path
 * @returns {{ tree: Array, flat: Array }}
 */
export function buildNav(pages, config, metas = new Map()) {
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const tree = config.sidebar ? buildExplicit(config.sidebar, bySlug) : buildAuto(pages, metas);
  return { tree, flat: flatten(tree) };
}
