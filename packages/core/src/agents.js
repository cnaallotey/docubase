import { squash } from './util.js';

/** Longest section text kept for the assistant, so one huge page cannot flood a prompt. */
export const CHUNK_LIMIT = 4000;

function absolute(config, relativeUrl) {
  return config.siteUrl ? config.siteUrl + relativeUrl : relativeUrl;
}

/** Where a page's Markdown source is served. "guides/writing.md" is served at `${base}guides/writing.md`. */
export function mdUrl(config, page) {
  return config.base + page.mdPath;
}

/** The Markdown for one page as an agent should read it: a title, the description, then the body. */
export function pageMarkdown(page) {
  const body = String(page.markdown ?? '')
    .split('\n')
    .filter((line) => !/^::try-it\{n=\d{1,5}\}\s*$/.test(line))
    .join('\n')
    .trim();
  const parts = [];
  if (!/^#\s/.test(body)) parts.push(`# ${page.title}`);
  if (page.hasDescription && page.description) parts.push(`> ${squash(page.description)}`);
  if (body) parts.push(body);
  return parts.join('\n\n') + '\n';
}

function linkText(text) {
  return String(text).replace(/([[\]\\])/g, '\\$1');
}

function collect(items, trail, bySlug, sections, loose) {
  for (const entry of items) {
    if (entry.type === 'page') {
      const page = bySlug.get(entry.slug);
      if (!page) continue;
      if (trail.length === 0) loose.push(page);
      else sections.get(trail.join(' / ')).push(page);
    } else {
      const next = [...trail, entry.label];
      const key = next.join(' / ');
      if (!sections.has(key)) sections.set(key, []);
      collect(entry.items, next, bySlug, sections, loose);
    }
  }
}

/** llms.txt: a short index of the site with links to the Markdown version of each page. */
export function buildLlmsTxt({ config, pages, nav }) {
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const sections = new Map();
  const loose = [];
  collect(nav.tree, [], bySlug, sections, loose);

  const line = (page) => {
    const url = absolute(config, mdUrl(config, page));
    const note = page.hasDescription && page.description ? `: ${squash(page.description)}` : '';
    return `- [${linkText(page.title)}](${url})${note}`;
  };

  const out = [`# ${squash(config.title)}`];
  if (config.description) out.push(`> ${squash(config.description)}`);
  if (loose.length > 0) out.push(['## Docs', ...loose.map(line)].join('\n'));
  for (const [label, list] of sections) {
    if (list.length > 0) out.push([`## ${squash(label)}`, ...list.map(line)].join('\n'));
  }
  const full = absolute(config, `${config.base}llms-full.txt`);
  out.push(['## Full text', `- [All pages in one file](${full}): every page as Markdown, for loading into a model at once`].join('\n'));
  return out.join('\n\n') + '\n';
}

/** llms-full.txt: every visible page as Markdown in sidebar order. */
export function buildLlmsFull({ config, pages, nav }) {
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const chunks = [];
  for (const entry of nav.flat) {
    const page = bySlug.get(entry.slug);
    if (!page) continue;
    chunks.push(`Source: ${absolute(config, page.url)}\n\n${pageMarkdown(page)}`);
  }
  return `${chunks.join('\n---\n\n')}`;
}

/**
 * The text the assistant searches. One chunk per page section, with ids that match the
 * browser search index so a cited section links to the same place.
 */
export function buildChunks(pages) {
  const chunks = [];
  for (const page of pages) {
    if (page.hidden) continue;
    for (const section of page.sections) {
      const text = String(section.text ?? '').slice(0, CHUNK_LIMIT);
      if (!text && !section.heading) continue;
      const url = section.id ? `${page.url}#${section.id}` : page.url;
      chunks.push({ id: url, title: page.title, heading: section.heading ?? '', url, text });
    }
  }
  return chunks;
}

export function buildAgentFiles(site) {
  return {
    llmsTxt: buildLlmsTxt(site),
    llmsFull: buildLlmsFull(site),
    chunks: buildChunks(site.pages),
  };
}
