import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, normalizeConfig, CONFIG_FILE } from './config.js';
import { ASSET_EXT, DOC_EXT, walk } from './files.js';
import { compilePage, createProcessor } from './markdown.js';
import { buildAgentFiles, buildChunks, buildLlmsFull, buildLlmsTxt, mdUrl, pageMarkdown } from './agents.js';
import { buildNav } from './nav.js';
import { buildApiPages, loadSpec } from './openapi.js';
import { buildSearchIndex, SEARCH_OPTIONS } from './search.js';
import { applyBaseline, findingKey, readBaseline, runDrift, writeBaseline, RULES as DRIFT_RULES } from './drift/index.js';
import { assertPublicHost, isPrivateAddress } from './netguard.js';
import { DocubaseError } from './util.js';

export {
  compilePage, createProcessor, loadConfig, normalizeConfig, buildNav, buildSearchIndex, SEARCH_OPTIONS, DocubaseError, CONFIG_FILE,
  buildChunks, buildLlmsFull, buildLlmsTxt, mdUrl, pageMarkdown, buildApiPages, loadSpec,
  runDrift, readBaseline, writeBaseline, applyBaseline, findingKey, DRIFT_RULES, assertPublicHost, isPrivateAddress,
};

async function readMetas(root, files) {
  const metas = new Map();
  for (const file of files) {
    if (path.posix.basename(file) !== '_meta.json') continue;
    const folder = path.posix.dirname(file);
    if (folder === '.') continue;
    try {
      metas.set(folder, JSON.parse(await readFile(path.join(root, file), 'utf8')));
    } catch (error) {
      throw new DocubaseError(`${file}: not valid JSON (${error.message})`);
    }
  }
  return metas;
}

/** Report links and images that point at things that do not exist. */
function validate(pages, assets) {
  const warnings = [];
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const assetSet = new Set(assets);

  for (const page of pages) {
    for (const link of page.links) {
      const target = bySlug.get(link.slug);
      if (!target) {
        warnings.push(`${page.source}: broken link "${link.text}" (no page at that path)`);
      } else if (link.hash && !target.headings.some((h) => h.id === link.hash)) {
        warnings.push(`${page.source}: link "${link.text}" points at a heading that does not exist`);
      }
    }
    for (const image of page.images) {
      if (!assetSet.has(image.path)) warnings.push(`${page.source}: image "${image.path}" was not found`);
    }
  }
  return warnings;
}

/**
 * Read a docs folder and return everything a theme needs: pages, navigation,
 * the search index, assets to copy, and warnings the author should fix.
 */
export async function loadSite(dir, { configOverrides = {} } = {}) {
  const root = path.resolve(dir);
  const loaded = await loadConfig(root);
  const config = Object.keys(configOverrides).length ? normalizeConfig({ ...loaded, ...configOverrides }) : loaded;
  const outDir = path.resolve(root, config.outDir);

  const files = await walk(root, { skipDirs: [outDir] });
  const docFiles = files.filter((f) => DOC_EXT.has(path.posix.extname(f).toLowerCase()) && !f.startsWith('public/'));
  const assets = files.filter((f) => ASSET_EXT.has(path.posix.extname(f).toLowerCase()) && !f.startsWith('public/'));
  const publicFiles = files.filter((f) => f.startsWith('public/')).map((f) => f.slice('public/'.length));

  const processor = createProcessor();
  const pages = await Promise.all(
    docFiles.map(async (source) =>
      compilePage({ source, raw: await readFile(path.join(root, source), 'utf8'), base: config.base, processor }),
    ),
  );
  const apiWarnings = [];

  // Pages generated from an OpenAPI file go through the same compiler as hand written ones.
  if (config.openapi) {
    const doc = await loadSpec(root, config.openapi.spec);
    const api = await buildApiPages({
      doc,
      openapi: config.openapi,
      compile: (source, raw) => compilePage({ source, raw, base: config.base, processor }),
    });
    pages.push(...api.pages);
    apiWarnings.push(...api.warnings);
  }

  const seen = new Map();
  for (const page of pages) {
    if (seen.has(page.slug)) {
      throw new DocubaseError(`${page.source} and ${seen.get(page.slug)} both produce the page "${page.url}". Rename one of them.`);
    }
    seen.set(page.slug, page.source);
    if (config.editUrl && !page.generated) page.editUrl = config.editUrl.replace('{path}', encodeURI(page.source));
  }

  const metas = await readMetas(root, files);
  if (config.openapi) {
    // Give the generated folder a label and position in the sidebar unless the author wrote a _meta.json for it.
    const folder = config.openapi.path;
    if (!metas.has(folder)) metas.set(folder, { label: config.openapi.title, order: config.openapi.order });
  }
  const nav = buildNav(pages, config, metas);

  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  nav.flat.forEach((entry, i) => {
    const page = bySlug.get(entry.slug);
    page.prev = i > 0 ? { title: nav.flat[i - 1].title, url: nav.flat[i - 1].url } : null;
    page.next = i < nav.flat.length - 1 ? { title: nav.flat[i + 1].title, url: nav.flat[i + 1].url } : null;
  });

  // A blog lists every dated page, newest first. Newer and older posts replace the sidebar order.
  let blog = null;
  if (config.blog.enabled) {
    const posts = pages
      .filter((p) => p.date && !p.hidden && !p.generated && p.slug !== '')
      .sort((a, b) => (a.date === b.date ? a.title.localeCompare(b.title) : b.date.localeCompare(a.date)));
    posts.forEach((post, i) => {
      post.isPost = true;
      post.next = i > 0 ? { title: posts[i - 1].title, url: posts[i - 1].url, label: 'Newer' } : null;
      post.prev = i < posts.length - 1 ? { title: posts[i + 1].title, url: posts[i + 1].url, label: 'Older' } : null;
    });
    for (const page of pages) if (!page.isPost) { page.prev = null; page.next = null; }
    blog = {
      posts: posts.map((p) => ({ title: p.title, url: p.url, slug: p.slug, date: p.date, author: p.author, description: p.description, hasDescription: p.hasDescription, readingMinutes: p.readingMinutes })),
    };
  }

  const favicon = ['favicon.svg', 'favicon.png', 'favicon.ico'].find((f) => publicFiles.includes(f)) ?? null;
  const search = buildSearchIndex(pages, nav.tree);
  const warnings = [...pages.flatMap((p) => p.warnings), ...apiWarnings, ...validate(pages, assets)];
  if (blog && !config.siteUrl) warnings.push(`${CONFIG_FILE}: set "siteUrl" so the blog gets an Atom feed (feed.xml)`);
  if (blog && blog.posts.length === 0) warnings.push('The blog has no posts yet. Give a page a "date" in its frontmatter to make it a post.');
  const agents = buildAgentFiles({ config, pages, nav });

  return { root, outDir, config, pages, nav, assets, publicFiles, favicon, search, agents, warnings, blog };
}
