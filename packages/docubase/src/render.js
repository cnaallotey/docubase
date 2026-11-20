/** HTML templates for the default theme. Every value that comes from a file or config is escaped. */
import { mdUrl } from '@docubase/core';

export function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ICON_MENU =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
const ICON_THEME =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>';
const ICON_ASK =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>';
const ICON_SEARCH =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

function containsUrl(group, url) {
  return group.items.some((entry) => (entry.type === 'page' ? entry.url === url : containsUrl(entry, url)));
}

function renderNav(items, currentUrl) {
  const rows = items.map((entry) => {
    if (entry.type === 'page') {
      const current = entry.url === currentUrl ? ' aria-current="page"' : '';
      return `<li><a href="${esc(entry.url)}"${current}>${esc(entry.title)}</a></li>`;
    }
    const open = containsUrl(entry, currentUrl) ? ' open' : '';
    return `<li><details${open}><summary>${esc(entry.label)}</summary>${renderNav(entry.items, currentUrl)}</details></li>`;
  });
  return `<ul>${rows.join('')}</ul>`;
}

function renderToc(page) {
  const headings = page.headings.filter((h) => h.depth <= 3);
  if (headings.length < 2) return '';
  const rows = headings
    .map((h) => `<li class="depth-${h.depth}"><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`)
    .join('');
  return `<aside class="toc" aria-label="On this page"><h2>On this page</h2><ul>${rows}</ul></aside>`;
}

function renderPager(page) {
  if (!page.prev && !page.next) return '';
  const prev = page.prev
    ? `<a class="prev" href="${esc(page.prev.url)}" rel="prev"><small>${esc(page.prev.label || 'Previous')}</small>${esc(page.prev.title)}</a>`
    : '';
  const next = page.next
    ? `<a class="next" href="${esc(page.next.url)}" rel="next"><small>${esc(page.next.label || 'Next')}</small>${esc(page.next.title)}</a>`
    : '';
  return `<nav class="pager" aria-label="Pagination">${prev}${next}</nav>`;
}

/** The round mark beside the site name: the first letter of the title, like a letterhead monogram. */
export function brandLetter(title) {
  return (Array.from(String(title).trim())[0] || 'D').toUpperCase();
}

/** "20 November 2026" in the site's language. Dates are calendar days, so they are read as UTC. */
export function formatDate(date, lang = 'en') {
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
  } catch {
    return date;
  }
}

function postMeta(site, post) {
  const parts = [`<time datetime="${esc(post.date)}">${esc(formatDate(post.date, site.config.lang))}</time>`];
  if (post.author) parts.push(`<span>${esc(post.author)}</span>`);
  parts.push(`<span>${esc(post.readingMinutes)} min read</span>`);
  return `<p class="post-meta">${parts.join('<span class="dot" aria-hidden="true">·</span>')}</p>`;
}

function renderPostList(site) {
  if (!site.blog.posts.length) return '<p class="post-empty">No posts yet.</p>';
  const rows = site.blog.posts.map((post) => `<li class="post-item">
<a href="${esc(post.url)}">
<span class="post-item-date"><time datetime="${esc(post.date)}">${esc(formatDate(post.date, site.config.lang))}</time></span>
<span class="post-item-title">${esc(post.title)}</span>
${post.hasDescription ? `<span class="post-item-text">${esc(post.description)}</span>` : ''}
<span class="post-item-more">${esc(post.readingMinutes)} min read</span>
</a>
</li>`).join('\n');
  return `<ol class="post-list" reversed>\n${rows}\n</ol>`;
}

export function askEndpoint(config) {
  return config.assistant.endpoint || `${config.base}__docubase/ask`;
}

/** JSON that is safe inside a script tag: no closing tag or line separator can end the block early. */
function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function shell(site, { title, description, body, currentUrl, toc = '', version, extraHead = '' }) {
  const { config } = site;
  const isBlog = Boolean(site.blog);
  const feed = isBlog && config.siteUrl ? `<link rel="alternate" type="application/atom+xml" title="${esc(config.title)}" href="${esc(config.base)}feed.xml">\n` : '';
  const pageTitle = title && title !== config.title ? `${title} · ${config.title}` : config.title;
  const topLinks = config.links
    .map((link) => {
      const external = /^https?:/i.test(link.href);
      return `<a href="${esc(link.href)}"${external ? ' rel="noopener noreferrer"' : ''}>${esc(link.label)}</a>`;
    })
    .join('');
  const homeUrl = config.base;

  return `<!doctype html>
<html lang="${esc(config.lang)}" data-base="${esc(config.base)}" data-v="${esc(version)}"${config.assistant.enabled ? ` data-ask="${esc(askEndpoint(config))}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(description || config.description)}">
<meta name="color-scheme" content="light dark">
<meta property="og:title" content="${esc(pageTitle)}">
<meta property="og:description" content="${esc(description || config.description)}">
<link rel="icon" href="${site.favicon ? esc(config.base + site.favicon) : 'data:,'}">
<script>try{var t=localStorage.getItem('docubase-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}</script>
<link rel="preload" href="${esc(config.base)}assets/fonts/eb-garamond-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${esc(config.base)}assets/docubase.css?v=${esc(version)}">
<style>:root{--accent:${esc(config.theme.accent)}}</style>
${feed}${extraHead}</head>
<body${isBlog ? ' class="layout-blog"' : ''}>
<a class="skip" href="#content">Skip to content</a>
<header class="topbar">
  ${isBlog ? '' : `<button class="icon-btn nav-toggle" type="button" aria-label="Toggle navigation" aria-expanded="false" aria-controls="sidebar">${ICON_MENU}</button>`}
  <a class="brand" href="${esc(homeUrl)}"><span class="brand-mark" aria-hidden="true">${esc(brandLetter(config.title))}</span>${esc(config.title)}</a>
  <div class="topbar-spacer"></div>
  ${config.assistant.enabled ? `<button class="ask-btn" type="button" aria-label="Ask the docs assistant">${ICON_ASK}<span class="label">Ask AI</span></button>` : ''}
  <button class="search-btn" type="button" aria-label="Search docs">${ICON_SEARCH}<span class="label">Search</span><kbd>Ctrl K</kbd></button>
  <nav class="toplinks" aria-label="Site links">${topLinks}</nav>
  <button class="icon-btn theme-toggle" type="button" aria-label="Switch between light and dark theme">${ICON_THEME}</button>
</header>
<div class="shell">
  ${isBlog ? '' : `<aside class="sidebar" id="sidebar"><nav aria-label="Documentation">${renderNav(site.nav.tree, currentUrl)}</nav></aside>`}
  <main id="content" class="content">
${body}
  </main>
  ${isBlog ? '' : toc}
</div>
${config.assistant.enabled ? `<dialog class="ask" id="ask-dialog" aria-label="Ask the docs assistant">
  <form class="ask-form">
    <label class="ask-label" for="ask-input">Ask a question about these docs</label>
    <textarea id="ask-input" rows="3" maxlength="${esc(config.assistant.maxQuestionLength)}" placeholder="How do I deploy to a subfolder?"></textarea>
    <div class="ask-actions"><span class="ask-note">Answers come from these docs and can be wrong. Check the linked pages.</span><button type="submit" class="ask-send">Ask</button></div>
    <div class="ask-answer" role="status" aria-live="polite"></div>
    <ul class="ask-sources"></ul>
  </form>
</dialog>
` : ''}<dialog class="search" id="search-dialog" aria-label="Search docs">
  <form method="dialog">
    <input type="search" placeholder="Search the docs" aria-label="Search the docs" autocomplete="off" spellcheck="false">
    <p class="search-status" role="status"></p>
    <ul class="search-results"></ul>
  </form>
</dialog>
<script src="${esc(config.base)}assets/docubase.js?v=${esc(version)}" defer></script>
</body>
</html>
`;
}

export function renderPage(site, page, { version }) {
  const isHome = page.slug === '';
  const lead = page.hasDescription ? `<p class="lead">${esc(page.description)}</p>` : '';
  const md = mdUrl(site.config, page);
  const links = [
    page.editUrl ? `<a class="edit-link" href="${esc(page.editUrl)}" rel="noopener noreferrer">Edit this page</a>` : '',
    `<a class="edit-link" href="${esc(md)}" type="text/markdown">View as Markdown</a>`,
  ].filter(Boolean).join('');
  const operations = page.api ? page.api.operations : [];
  const apiData = operations.length > 0 ? `<script type="application/json" id="docubase-api">${safeJson(operations)}</script>` : '';
  const footer = site.config.footer ? `<footer class="site-footer">${esc(site.config.footer)}</footer>` : '';
  const meta = page.isPost ? postMeta(site, page) : '';
  const heading = page.isPost ? `<h1 class="page-title">${esc(page.title)}</h1>\n${meta}\n${lead}` : `<h1 class="page-title">${esc(page.title)}</h1>\n${lead}`;
  const postList = site.blog && isHome ? renderPostList(site) : '';
  const body = `<article class="prose${isHome ? ' is-home' : ''}${page.isPost ? ' is-post' : ''}">
${isHome ? `<header class="page-hero">\n${heading}\n</header>` : heading}
${page.html}
${postList}
</article>
<div class="page-links">${links}</div>
${apiData}
${renderPager(page)}
${footer}`;

  return shell(site, {
    title: isHome ? site.config.title : page.title,
    description: page.description,
    body,
    currentUrl: page.url,
    toc: renderToc(page),
    version,
    extraHead: `<link rel="alternate" type="text/markdown" href="${esc(md)}">\n`,
  });
}

export function renderNotFound(site, { version }) {
  const body = `<div class="not-found">
<h1>404</h1>
<p>This page does not exist.</p>
<p><a href="${esc(site.config.base)}">Go to the start page</a></p>
</div>`;
  return shell(site, {
    title: 'Page not found',
    description: '',
    body,
    currentUrl: '',
    version,
    extraHead: '<meta name="robots" content="noindex">\n',
  });
}
