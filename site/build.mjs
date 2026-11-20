#!/usr/bin/env node
// Builds the Docubase website for Cloudflare Pages: the marketing pages, the docs at /docs/ and the
// journal at /blog/, both made with Docubase itself. Output: site/dist
//
//   node site/build.mjs                    uses siteUrl from site/site.config.json
//   SITE_URL=https://docubase.dev node site/build.mjs
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSite } from '../packages/core/src/index.js';
import { build, FONT_FILES, fontSource } from '../packages/docubase/src/build.js';
import { formatDate } from '../packages/docubase/src/render.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const src = path.join(here, 'src');
const out = path.join(here, 'dist');
const MARKER = '.site-build';
const started = Date.now();

const config = JSON.parse(await readFile(path.join(here, 'site.config.json'), 'utf8'));
const siteUrl = String(process.env.SITE_URL || config.siteUrl || '').replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+$/.test(siteUrl)) throw new Error('Set siteUrl in site/site.config.json, or SITE_URL, to an origin such as https://docubase.dev');
const githubUrl = process.env.GITHUB_URL || config.githubUrl || null;
const dashboardUrl = process.env.DASHBOARD_URL || config.dashboardUrl || '/docs/guides/managed-hosting/';

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sha = (buf, n = 10) => createHash('sha256').update(buf).digest('hex').slice(0, n);

// ---- A clean output folder, refusing to delete anything that is not ours ------------------------------
try {
  const entries = await readdir(out);
  if (entries.length && !entries.includes(MARKER)) throw new Error(`${out} has files this script did not write. Move them before building.`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, 'assets', 'fonts'), { recursive: true });

// ---- Assets: fingerprinted so they can be cached forever ----------------------------------------------
// The marketing pages use the same bundled serif as the docs theme. Its @font-face rules lead the stylesheet.
const fontCss = FONT_FILES.filter((f) => !f.includes('latin-ext')).map((file) => {
  const [, weight, style] = /-(\d00)-(normal|italic)\./.exec(file);
  return `@font-face{font-family:"EB Garamond";font-style:${style};font-weight:${weight};font-display:swap;src:url(/assets/fonts/${file}) format("woff2")}`;
}).join('\n');
const css = Buffer.from(`${fontCss}\n${await readFile(path.join(src, 'assets', 'site.css'), 'utf8')}`);
const js = await readFile(path.join(src, 'assets', 'site.js'));
const cssName = `site.${sha(css)}.css`;
const jsName = `site.${sha(js)}.js`;
await writeFile(path.join(out, 'assets', cssName), css);
await writeFile(path.join(out, 'assets', jsName), js);
for (const file of FONT_FILES) await copyFile(fontSource(file), path.join(out, 'assets', 'fonts', file));

// ---- Docs and journal, built by Docubase -------------------------------------------------------------
const topLinks = (skip) => [
  { label: 'Home', href: '/' },
  { label: 'Docs', href: '/docs/' },
  { label: 'Journal', href: '/blog/' },
  { label: 'Pricing', href: '/pricing/' },
].filter((l) => l.href !== skip);

async function buildWithDocubase(dir, base) {
  const site = await loadSite(dir, { configOverrides: { base, siteUrl, links: topLinks(base) } });
  for (const warning of site.warnings) console.warn(`  warning (${base}): ${warning}`);
  const result = await build(site, { out: path.join(out, base.replace(/^\/|\/$/g, '')), safe: false });
  return { site, result };
}
const docs = await buildWithDocubase(path.join(repo, 'examples', 'docs'), '/docs/');
const blog = await buildWithDocubase(path.join(here, 'blog'), '/blog/');

// ---- Marketing pages ---------------------------------------------------------------------------------
const header = await readFile(path.join(src, '_header.html'), 'utf8');
const footer = await readFile(path.join(src, '_footer.html'), 'utf8');
const github = githubUrl ? `<a href="${esc(githubUrl)}" rel="noopener noreferrer">GitHub</a>` : '';
const githubFooter = githubUrl ? `<a href="${esc(githubUrl)}" rel="noopener noreferrer">Source on GitHub</a>` : '';

const posts = blog.site.blog.posts.slice(0, 3).map((post, i) => `      <li data-reveal style="--rd:${i}"><a href="${esc(post.url)}">
        <time datetime="${esc(post.date)}">${esc(formatDate(post.date, 'en'))}</time>
        <span class="j-title">${esc(post.title)}</span>
        <span class="j-more">${esc(post.readingMinutes)} min read</span>
      </a></li>`).join('\n');

const values = {
  head: [
    `<link rel="preload" href="/assets/fonts/eb-garamond-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>`,
    `<link rel="stylesheet" href="/assets/${cssName}">`,
    `<link rel="alternate" type="application/atom+xml" title="Docubase Journal" href="/blog/feed.xml">`,
    `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#2f5d46"/><text x="32" y="45" font-family="Georgia,serif" font-size="38" text-anchor="middle" fill="#fff">D</text></svg>')}">`,
  ].join('\n'),
  scripts: `<script src="/assets/${jsName}" defer></script>`,
  header: header.replaceAll('{{github}}', github),
  footer: footer.replace('{{githubFooter}}', githubFooter),
  posts,
  dashboardUrl: esc(dashboardUrl),
  proPrice: esc(config.plans.proPrice),
  proPeriod: esc(config.plans.proPeriod),
  freeSites: esc(config.plans.freeSites),
  proSites: esc(config.plans.proSites),
};

async function pages(dir, rel = '') {
  const list = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_') || entry.name === 'assets') continue;
    const relPath = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) list.push(...(await pages(path.join(dir, entry.name), relPath)));
    else if (entry.name.endsWith('.html')) list.push(relPath);
  }
  return list;
}
const htmlPages = await pages(src);
for (const rel of htmlPages) {
  let html = await readFile(path.join(src, rel), 'utf8');
  // Two passes, because partials contain placeholders of their own.
  for (let i = 0; i < 2; i++) html = html.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in values ? values[key] : m));
  const left = html.match(/\{\{\w+\}\}/);
  if (left) throw new Error(`${rel}: unknown placeholder ${left[0]}`);
  await mkdir(path.dirname(path.join(out, rel)), { recursive: true });
  await writeFile(path.join(out, rel), html);
}

// ---- Cloudflare Pages headers, redirects, sitemap and robots ---------------------------------------
// Docubase pages carry one small inline script (the saved colour theme). Allow exactly that script by hash.
const sample = await readFile(path.join(out, 'docs', 'index.html'), 'utf8');
const inline = [...sample.matchAll(/<script>([^<]*)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
const common = [
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  '  Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()',
  '  Strict-Transport-Security: max-age=31536000; includeSubDomains',
  '  X-Frame-Options: DENY',
].join('\n');
const headers = `# Generated by site/build.mjs
/*
${common}
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'

/docs/*
  ! Content-Security-Policy
  Content-Security-Policy: default-src 'self'; script-src 'self' ${inline.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'

/blog/*
  ! Content-Security-Policy
  Content-Security-Policy: default-src 'self'; script-src 'self' ${inline.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/docs/assets/*
  Cache-Control: public, max-age=31536000, immutable

/blog/assets/*
  Cache-Control: public, max-age=31536000, immutable

/blog/feed.xml
  Content-Type: application/atom+xml; charset=utf-8
  Cache-Control: public, max-age=600
`;
await writeFile(path.join(out, '_headers'), headers);

await writeFile(path.join(out, '_redirects'), `# Generated by site/build.mjs
/llms.txt /docs/llms.txt 302
/llms-full.txt /docs/llms-full.txt 302
/journal /blog/ 301
/feed.xml /blog/feed.xml 301
`);

const urls = [
  ...htmlPages.filter((p) => p !== '404.html').map((p) => `/${p.replace(/index\.html$/, '')}`),
  ...docs.site.pages.filter((p) => !p.hidden).map((p) => p.url),
  ...blog.site.pages.filter((p) => !p.hidden).map((p) => p.url),
];
await writeFile(path.join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(siteUrl + u)}</loc></url>`).join('\n')}
</urlset>
`);
await writeFile(path.join(out, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`);
await writeFile(path.join(out, MARKER), 'Created by site/build.mjs. This folder is replaced on every build.\n');

// ---- Report -------------------------------------------------------------------------------------------
const kb = async (rel) => ((await stat(path.join(out, rel))).size / 1024).toFixed(1);
console.log(`Built ${siteUrl} into site/dist in ${Date.now() - started} ms`);
console.log(`  marketing: ${htmlPages.length} pages, index.html ${await kb('index.html')} KB, ${cssName} ${await kb(`assets/${cssName}`)} KB, ${jsName} ${await kb(`assets/${jsName}`)} KB`);
console.log(`  docs:      ${docs.result.pages} pages at /docs/`);
console.log(`  journal:   ${blog.result.pages} pages at /blog/, ${blog.site.blog.posts.length} posts, feed at /blog/feed.xml`);
