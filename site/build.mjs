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
import { createRequire } from 'node:module';
import { build } from '../packages/docubase/src/build.js';
import { formatDate } from '../packages/docubase/src/render.js';
import { CARD_HEIGHT, CARD_WIDTH, createCardRenderer } from './og.mjs';

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
// The marketing pages use Geist and Geist Mono, both SIL Open Font License,
// self-hosted from their npm packages so the site makes no requests to other servers.
const require = createRequire(import.meta.url);
const FONTS = [
  ['geist', 'Geist', 400, 'normal'],
  ['geist', 'Geist', 500, 'normal'],
  ['geist', 'Geist', 600, 'normal'],
  ['geist-mono', 'Geist Mono', 400, 'normal'],
  ['geist-mono', 'Geist Mono', 500, 'normal'],
].map(([pkg, family, weight, style]) => ({ pkg, family, weight, style, file: `${pkg}-latin-${weight}-${style}.woff2` }));
const fontCss = FONTS.map((f) => `@font-face{font-family:"${f.family}";font-style:${f.style};font-weight:${f.weight};font-display:swap;src:url(/assets/fonts/${f.file}) format("woff2")}`).join('\n');
const css = Buffer.from(`${fontCss}\n${await readFile(path.join(src, 'assets', 'site.css'), 'utf8')}`);
const js = await readFile(path.join(src, 'assets', 'site.js'));
const scene = await readFile(path.join(src, 'assets', 'scene.js'));
const cssName = `site.${sha(css)}.css`;
const jsName = `site.${sha(js)}.js`;
const sceneName = `scene.${sha(scene)}.js`;
await writeFile(path.join(out, 'assets', cssName), css);
await writeFile(path.join(out, 'assets', jsName), js);
await writeFile(path.join(out, 'assets', sceneName), scene);
for (const f of FONTS) await copyFile(path.join(path.dirname(require.resolve(`@fontsource/${f.pkg}/package.json`)), 'files', f.file), path.join(out, 'assets', 'fonts', f.file));

// ---- Docs and journal, built by Docubase -------------------------------------------------------------
const topLinks = (skip) => [
  { label: 'Home', href: '/' },
  { label: 'Docs', href: '/docs/' },
  { label: 'Journal', href: '/blog/' },
  { label: 'Pricing', href: '/pricing/' },
].filter((l) => l.href !== skip);

async function buildWithDocubase(dir, base) {
  // Every page points at its own social card, drawn further down into /og/<section>/<page>.png.
  const socialImage = `/og/${base.replace(/^\/|\/$/g, '')}/{page}.png`;
  const site = await loadSite(dir, { configOverrides: { base, siteUrl, links: topLinks(base), socialImage, ...(config.twitter ? { twitter: config.twitter } : {}) } });
  for (const warning of site.warnings) console.warn(`  warning (${base}): ${warning}`);
  const result = await build(site, { out: path.join(out, base.replace(/^\/|\/$/g, '')), safe: false });
  return { site, result };
}
const docs = await buildWithDocubase(path.join(repo, 'examples', 'docs'), '/docs/');
const blog = await buildWithDocubase(path.join(here, 'blog'), '/blog/');

// ---- Icons and social cards ------------------------------------------------------------------------
const MARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="#050506"/><g fill="#fbff54"><rect x="29" y="14" width="6" height="36" rx="3"/><rect x="29" y="14" width="6" height="36" rx="3" transform="rotate(60 32 32)"/><rect x="29" y="14" width="6" height="36" rx="3" transform="rotate(-60 32 32)"/></g></svg>';
await writeFile(path.join(out, 'favicon.svg'), MARK_SVG);
{
  const { Resvg } = await import('@resvg/resvg-js');
  await writeFile(path.join(out, 'apple-touch-icon.png'), new Resvg(MARK_SVG.replace('rx="18"', 'rx="0"'), { fitTo: { mode: 'width', value: 180 } }).render().asPng());
}
const ICONS = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">';

const renderCard = await createCardRenderer();
const host = new URL(siteUrl).host;
const cardUrl = (url) => (host + url).replace(/\/$/, '');
let cards = 0;
async function writeCard(rel, options) {
  const file = path.join(out, 'og', rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, renderCard(options));
  cards++;
}
const section = (slug) => {
  const first = slug.split('/')[0];
  return first === 'api' ? 'API' : first.charAt(0).toUpperCase() + first.slice(1);
};
for (const page of docs.site.pages) {
  await writeCard(`docs/${page.slug || 'index'}.png`, {
    title: page.title,
    description: page.description,
    label: page.slug.includes('/') ? `Docs · ${section(page.slug)}` : 'Docs',
    url: cardUrl(page.url),
    seed: page.url,
  });
}
for (const page of blog.site.pages) {
  await writeCard(`blog/${page.slug || 'index'}.png`, {
    title: page.title,
    description: page.description,
    label: page.isPost && page.date ? `Journal · ${formatDate(page.date, 'en')}` : 'Journal',
    url: cardUrl(page.url),
    seed: page.url,
  });
}

// Dress the docs and journal like the rest of the site: a skin loaded after the Docubase theme, with
// Geist preloaded in place of the theme's serif.
const skin = Buffer.from(`${fontCss}\n${await readFile(path.join(src, 'assets', 'docs-skin.css'), 'utf8')}`);
const skinName = `docs-skin.${sha(skin)}.css`;
await writeFile(path.join(out, 'assets', skinName), skin);
async function htmlFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await htmlFiles(full)));
    else if (entry.name.endsWith('.html')) found.push(full);
  }
  return found;
}
for (const dir of ['docs', 'blog']) {
  for (const file of await htmlFiles(path.join(out, dir))) {
    let html = await readFile(file, 'utf8');
    html = html.replace(/<link rel="preload" href="[^"]*eb-garamond[^"]*"[^>]*>/, '<link rel="preload" href="/assets/fonts/geist-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>');
    html = html.replace('<link rel="icon" href="data:,">', ICONS);
    const withSkin = html.replace(/(<style>:root\{--accent:[^<]*<\/style>)/, `$1\n<link rel="stylesheet" href="/assets/${skinName}">`);
    if (withSkin === html) throw new Error(`could not add the skin to ${path.relative(out, file)}`);
    await writeFile(file, withSkin);
  }
}

// ---- Marketing pages ---------------------------------------------------------------------------------
const header = await readFile(path.join(src, '_header.html'), 'utf8');
const footer = await readFile(path.join(src, '_footer.html'), 'utf8');
const github = githubUrl ? `<a href="${esc(githubUrl)}" rel="noopener noreferrer">GitHub</a>` : '';
const githubFooter = githubUrl ? `<a href="${esc(githubUrl)}" rel="noopener noreferrer">Source on GitHub</a>` : '';

const arrow = '<span class="bi" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>';
const posts = blog.site.blog.posts.slice(0, 3).map((post, i) => `        <li data-reveal style="--rd:${i}"><a href="${esc(post.url)}">
          <time datetime="${esc(post.date)}">${esc(formatDate(post.date, 'en'))}</time>
          <span class="p-title">${esc(post.title)}</span>
          <span class="p-more">${esc(post.readingMinutes)} min read${arrow}</span>
        </a></li>`).join('\n');
const plans = await readFile(path.join(src, '_plans.html'), 'utf8');
const faq = await readFile(path.join(src, '_faq.html'), 'utf8');

const values = {
  head: [
    `<link rel="preload" href="/assets/fonts/geist-latin-600-normal.woff2" as="font" type="font/woff2" crossorigin>`,
    `<link rel="preload" href="/assets/fonts/geist-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>`,
    `<link rel="stylesheet" href="/assets/${cssName}">`,
    `<link rel="alternate" type="application/atom+xml" title="Docubase Journal" href="/blog/feed.xml">`,
    ICONS,
  ].join('\n'),
  scripts: `<script src="/assets/${jsName}" defer></script>\n<script src="/assets/${sceneName}" defer></script>`,
  header: header.replaceAll('{{github}}', github),
  footer: footer.replace('{{githubFooter}}', githubFooter),
  posts,
  plans,
  faq,
  arrow,
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
// Search and link preview tags for the marketing pages. Title and description come from each page's own
// <title> and meta description; the card title is written for the image.
const SOFTWARE = {
  '@type': 'SoftwareApplication',
  name: 'Docubase',
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'macOS, Linux, Windows',
  description: 'Open source docs from a folder of Markdown, with search, Ask AI, MCP for agents and hosting from git.',
  license: 'https://opensource.org/licenses/MIT',
  url: `${siteUrl}/`,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  ...(githubUrl ? { codeRepository: githubUrl } : {}),
};
const MARKETING = {
  'index.html': { card: 'home', cardTitle: 'Markdown in.\nA docs site out.', label: 'Open source', schema: [{ '@type': 'WebSite', name: 'Docubase', url: `${siteUrl}/` }, SOFTWARE] },
  'pricing/index.html': { card: 'pricing', cardTitle: 'Free to run.\nSimple to host.', label: 'Pricing', schema: [{ '@type': 'WebPage', name: 'Docubase pricing', url: `${siteUrl}/pricing/` }] },
};
const attr = (html, re) => (html.match(re) || [])[1] || '';
const unesc = (v) => v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
async function marketingSeo(rel, html) {
  const seo = MARKETING[rel];
  if (!seo) return html;
  const title = unesc(attr(html, /<title>([^<]*)<\/title>/));
  const description = unesc(attr(html, /<meta name="description" content="([^"]*)">/));
  const url = `${siteUrl}/${rel.replace(/index\.html$/, '')}`;
  const image = `${siteUrl}/og/${seo.card}.png`;
  await writeCard(`${seo.card}.png`, { title: seo.cardTitle, description, label: seo.label, url: cardUrl(url.slice(siteUrl.length)), seed: url });
  const tags = [
    `<link rel="canonical" href="${esc(url)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Docubase">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta property="og:image:width" content="${CARD_WIDTH}">`,
    `<meta property="og:image:height" content="${CARD_HEIGHT}">`,
    `<meta property="og:image:alt" content="${esc(seo.cardTitle.replace(/\n/g, ' '))}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    ...(config.twitter ? [`<meta name="twitter:site" content="${esc(config.twitter)}">`] : []),
    `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': seo.schema }).replace(/</g, '\\u003c')}</script>`,
  ];
  return html.replace('</head>', `${tags.join('\n')}\n</head>`);
}

const htmlPages = await pages(src);
for (const rel of htmlPages) {
  let html = await readFile(path.join(src, rel), 'utf8');
  // Two passes, because partials contain placeholders of their own.
  for (let i = 0; i < 2; i++) html = html.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in values ? values[key] : m));
  const left = html.match(/\{\{\w+\}\}/);
  if (left) throw new Error(`${rel}: unknown placeholder ${left[0]}`);
  html = await marketingSeo(rel, html);
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

/og/*
  Cache-Control: public, max-age=86400

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
  ...htmlPages.filter((p) => p !== '404.html').map((p) => ({ url: `/${p.replace(/index\.html$/, '')}` })),
  ...docs.site.pages.filter((p) => !p.hidden).map((p) => ({ url: p.url })),
  ...blog.site.pages.filter((p) => !p.hidden).map((p) => ({ url: p.url, lastmod: p.date })),
];
await writeFile(path.join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(siteUrl + u.url)}</loc>${u.lastmod ? `<lastmod>${esc(u.lastmod)}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`);
await writeFile(path.join(out, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`);
await writeFile(path.join(out, MARKER), 'Created by site/build.mjs. This folder is replaced on every build.\n');

// ---- Report -------------------------------------------------------------------------------------------
const kb = async (rel) => ((await stat(path.join(out, rel))).size / 1024).toFixed(1);
console.log(`Built ${siteUrl} into site/dist in ${Date.now() - started} ms`);
console.log(`  marketing: ${htmlPages.length} pages, index.html ${await kb('index.html')} KB, ${cssName} ${await kb(`assets/${cssName}`)} KB, ${jsName} ${await kb(`assets/${jsName}`)} KB, ${sceneName} ${await kb(`assets/${sceneName}`)} KB`);
console.log(`  docs:      ${docs.result.pages} pages at /docs/`);
console.log(`  social:    ${cards} cards in /og/, favicon.svg, apple-touch-icon.png`);
console.log(`  skin:      ${skinName} on every docs and journal page`);
console.log(`  journal:   ${blog.result.pages} pages at /blog/, ${blog.site.blog.posts.length} posts, feed at /blog/feed.xml`);
