import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocubaseError, pageMarkdown } from '@docubase/core';
import { renderNotFound, renderPage } from './render.js';

export const CHUNKS_FILE = 'docubase-chunks.json';
export const MCP_FILE = 'docubase-mcp.json';
const THEME_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'theme');
const MARKER = '.docubase-build';
const require = createRequire(import.meta.url);

/** Find the browser bundle of MiniSearch that ships inside the installed package. */
async function findMiniSearchBundle() {
  let dir = path.dirname(require.resolve('minisearch'));
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'dist', 'umd', 'index.js');
    try {
      await access(candidate);
      return candidate;
    } catch {
      dir = path.dirname(dir);
    }
  }
  throw new DocubaseError('Could not find the MiniSearch browser bundle. Reinstall docubase.');
}

/** EB Garamond (SIL Open Font License) ships with the theme, so docs sites never load fonts from elsewhere. */
export const FONT_FILES = ['400-normal', '400-italic', '500-normal', '600-normal'].flatMap((v) => [`eb-garamond-latin-${v}.woff2`, `eb-garamond-latin-ext-${v}.woff2`]);

export function fontSource(file) {
  if (!FONT_FILES.includes(file)) throw new DocubaseError(`Unknown font file ${file}`);
  return path.join(path.dirname(require.resolve('@fontsource/eb-garamond/package.json')), 'files', file);
}

/**
 * Refuse to delete a folder that is not clearly ours.
 * The output folder is wiped before every build, so a wrong --out value must never remove real work.
 */
async function prepareOutDir(out, root) {
  const rel = path.relative(out, root);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new DocubaseError(`The output folder (${out}) contains your docs folder. Choose a different --out folder.`);
  }
  let entries = [];
  try {
    entries = await readdir(out);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (entries.length > 0 && !entries.includes(MARKER)) {
    throw new DocubaseError(
      `The output folder ${out} is not empty and was not created by Docubase, so it was left alone. Pick an empty folder or delete it yourself.`,
    );
  }
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
}

async function writeFileDeep(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function copyDeep(from, to) {
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
}

/**
 * Write everything a site needs besides its HTML pages: theme files, search index, Markdown routes,
 * llms files, the assistant's chunks, and the author's own assets. Themes other than the default one
 * (such as the Nuxt theme) call this and render their own HTML.
 * @returns {Promise<{ version: string, files: number }>}
 */
export async function writeSupportFiles(site, outDir) {
  const css = await readFile(path.join(THEME_DIR, 'docubase.css'));
  const js = await readFile(path.join(THEME_DIR, 'docubase.js'));
  const version = createHash('sha1').update(css).update(js).digest('hex').slice(0, 8);

  const assetsDir = path.join(outDir, 'assets');
  await mkdir(assetsDir, { recursive: true });
  await writeFile(path.join(assetsDir, 'docubase.css'), css);
  await writeFile(path.join(assetsDir, 'docubase.js'), js);
  await copyFile(await findMiniSearchBundle(), path.join(assetsDir, 'minisearch.js'));
  await mkdir(path.join(assetsDir, 'fonts'), { recursive: true });
  for (const file of FONT_FILES) await copyFile(fontSource(file), path.join(assetsDir, 'fonts', file));
  let files = 3 + FONT_FILES.length;

  // The "public" folder maps to the site root. Copied first so generated files always win.
  for (const rel of site.publicFiles) {
    await copyDeep(path.join(site.root, 'public', rel), path.join(outDir, rel));
    files += 1;
  }
  for (const rel of site.assets) {
    await copyDeep(path.join(site.root, rel), path.join(outDir, rel));
    files += 1;
  }

  // Every page is also served as plain Markdown, which is what coding agents and llms.txt link to.
  for (const page of site.pages) {
    await writeFileDeep(path.join(outDir, page.mdPath), pageMarkdown(page));
    files += 1;
  }
  await writeFileDeep(path.join(outDir, 'llms.txt'), site.agents.llmsTxt);
  await writeFileDeep(path.join(outDir, 'llms-full.txt'), site.agents.llmsFull);
  await writeFileDeep(path.join(outDir, 'search-index.json'), JSON.stringify(site.search));
  files += 3;
  if (site.config.assistant.enabled) {
    await writeFileDeep(path.join(outDir, CHUNKS_FILE), JSON.stringify(site.agents.chunks));
    files += 1;
  }
  if (site.blog && site.config.siteUrl) {
    await writeFileDeep(path.join(outDir, 'feed.xml'), atomFeed(site));
    files += 1;
  }
  if (site.config.mcp.enabled) {
    await writeFileDeep(path.join(outDir, MCP_FILE), JSON.stringify(mcpSnapshot(site)));
    files += 1;
  }
  return { version, files };
}

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** An Atom feed of the newest 30 posts, with full content. Links are absolute, from siteUrl. */
export function atomFeed(site) {
  const { config } = site;
  const origin = config.siteUrl.replace(/\/+$/, '');
  const abs = (url) => origin + url;
  const posts = site.blog.posts.slice(0, 30).map((p) => site.pages.find((page) => page.slug === p.slug));
  const updated = posts.length ? `${posts[0].date}T00:00:00Z` : new Date().toISOString();
  const entries = posts.map((post) => `  <entry>
    <title>${xml(post.title)}</title>
    <link href="${xml(abs(post.url))}"/>
    <id>${xml(abs(post.url))}</id>
    <published>${post.date}T00:00:00Z</published>
    <updated>${post.date}T00:00:00Z</updated>
${post.author ? `    <author><name>${xml(post.author)}</name></author>\n` : ''}${post.hasDescription ? `    <summary>${xml(post.description)}</summary>\n` : ''}    <content type="html" xml:base="${xml(abs(post.url))}">${xml(post.html)}</content>
  </entry>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${xml(config.title)}</title>
${config.description ? `  <subtitle>${xml(config.description)}</subtitle>\n` : ''}  <link href="${xml(abs(config.base))}"/>
  <link rel="self" href="${xml(abs(`${config.base}feed.xml`))}"/>
  <id>${xml(abs(config.base))}</id>
  <updated>${updated}</updated>
  <author><name>${xml(config.title)}</name></author>
${entries}
</feed>
`;
}

/**
 * What the hosted MCP endpoint needs to answer without the source folder: page metadata, each page
 * as Markdown, the sidebar order and the search index. Everything in it is already public on the site.
 */
export function mcpSnapshot(site) {
  return {
    config: { base: site.config.base, title: site.config.title },
    pages: site.pages.map((p) => ({
      slug: p.slug,
      url: p.url,
      title: p.title,
      description: p.description,
      hasDescription: p.hasDescription,
      hidden: Boolean(p.hidden),
      rendered: pageMarkdown(p),
    })),
    nav: { flat: site.nav.flat.map((entry) => ({ slug: entry.slug })) },
    search: site.search,
  };
}

/**
 * Write the static site for a loaded site.
 * @returns {{ pages: number, files: number, out: string, version: string }}
 */
export async function build(site, { out = site.outDir, safe = true } = {}) {
  const outDir = path.resolve(out);
  if (safe) await prepareOutDir(outDir, site.root);
  else await mkdir(outDir, { recursive: true });

  const { version, files: supportFiles } = await writeSupportFiles(site, outDir);
  let files = supportFiles;

  for (const page of site.pages) {
    await writeFileDeep(path.join(outDir, page.slug, 'index.html'), renderPage(site, page, { version }));
    files += 1;
  }

  await writeFileDeep(path.join(outDir, '404.html'), renderNotFound(site, { version }));
  await writeFile(path.join(outDir, MARKER), 'Created by Docubase. This folder is replaced on every build.\n');
  files += 2;

  return { pages: site.pages.length, files, out: outDir, version };
}
