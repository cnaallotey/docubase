import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';
import { FONT_FILES } from '../src/build.js';

const quiet = { log: { log() {}, warn() {}, error() {} } };

test('the theme ships its serif font, a brand mark and a painted header on the start page', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'docubase-theme-'));
  await writeFile(path.join(root, 'docubase.config.json'), JSON.stringify({ title: 'élan docs' }));
  await writeFile(path.join(root, 'index.md'), '---\ndescription: Start here.\n---\n# Home\n\nHello.');
  await writeFile(path.join(root, 'guide.md'), '# Guide\n\nText.');
  assert.equal(await main(['build', root], quiet), 0);
  const out = path.join(root, 'dist');

  assert.equal(FONT_FILES.length, 8);
  for (const file of FONT_FILES) await access(path.join(out, 'assets', 'fonts', file));
  const css = await readFile(path.join(out, 'assets', 'docubase.css'), 'utf8');
  assert.match(css, /font-family: "EB Garamond"; font-style: normal; font-weight: 400;[^}]*url\(fonts\/eb-garamond-latin-400-normal\.woff2\)/);
  assert.ok(!/https?:\/\//.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'the stylesheet loads nothing from other servers');

  const home = await readFile(path.join(out, 'index.html'), 'utf8');
  assert.match(home, /<span class="brand-mark" aria-hidden="true">É<\/span>élan docs/);
  assert.match(home, /<article class="prose is-home">\n<header class="page-hero">\n<h1 class="page-title">Home<\/h1>\n<p class="lead">Start here\.<\/p>/);
  assert.match(home, /<link rel="preload" href="\/assets\/fonts\/eb-garamond-latin-400-normal\.woff2" as="font" type="font\/woff2" crossorigin>/);
  assert.match(home, /--accent:#2f5d46/, 'forest green is the default accent');

  const guide = await readFile(path.join(out, 'guide', 'index.html'), 'utf8');
  assert.ok(!guide.includes('page-hero'), 'other pages keep a plain heading');
});

test('blog mode lists dated posts newest first, links them in order and writes an Atom feed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'docubase-blog-'));
  await writeFile(path.join(root, 'docubase.config.json'), JSON.stringify({ title: 'Notes', blog: true, siteUrl: 'https://example.com' }));
  await writeFile(path.join(root, 'index.md'), '---\ntitle: Notes\ndescription: All the notes.\n---\n');
  await writeFile(path.join(root, 'first.md'), '---\ntitle: First <post>\ndate: 2026-01-02\nauthor: Ana\ndescription: The first one.\n---\n\nHello & welcome.');
  await writeFile(path.join(root, 'second.md'), '---\ntitle: Second\ndate: "2026-03-04"\n---\n\nMore.');
  await writeFile(path.join(root, 'about.md'), '# About\n\nNot a post, no date.');
  assert.equal(await main(['build', root], quiet), 0);
  const out = path.join(root, 'dist');

  const home = await readFile(path.join(out, 'index.html'), 'utf8');
  assert.match(home, /<body class="layout-blog">/);
  assert.ok(!home.includes('class="sidebar"'), 'a blog has no sidebar');
  const order = [...home.matchAll(/<span class="post-item-title">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(order, ['Second', 'First &lt;post&gt;'], 'newest first, titles escaped');
  assert.ok(!home.includes('post-item-title">About'), 'pages without a date are not posts');
  assert.match(home, /<link rel="alternate" type="application\/atom\+xml" title="Notes" href="\/feed\.xml">/);

  const first = await readFile(path.join(out, 'first', 'index.html'), 'utf8');
  assert.match(first, /<p class="post-meta"><time datetime="2026-01-02">January 2, 2026<\/time>/);
  assert.match(first, /<span>Ana<\/span>/);
  assert.match(first, /<a class="next" href="\/second\/" rel="next"><small>Newer<\/small>Second<\/a>/);

  const feed = await readFile(path.join(out, 'feed.xml'), 'utf8');
  assert.match(feed, /^<\?xml version="1.0" encoding="utf-8"\?>\n<feed xmlns="http:\/\/www.w3.org\/2005\/Atom">/);
  assert.match(feed, /<title>First &lt;post&gt;<\/title>\n    <link href="https:\/\/example.com\/first\/"\/>/);
  assert.match(feed, /<updated>2026-03-04T00:00:00Z<\/updated>/);
  assert.ok(feed.indexOf('Second') < feed.indexOf('First'), 'newest entry first');
  assert.match(feed, /Hello &amp;(amp|#x26);/, "content is escaped HTML");
});

test('a bad post date stops the build and names the file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'docubase-blog-bad-'));
  await writeFile(path.join(root, 'docubase.config.json'), JSON.stringify({ blog: true }));
  await writeFile(path.join(root, 'post.md'), '---\ndate: next tuesday\n---\n# Post');
  const errors = [];
  assert.equal(await main(['build', root], { log: { log() {}, warn() {}, error: (m) => errors.push(String(m)) } }), 1);
  assert.match(errors.join('\n'), /post\.md: frontmatter "date" must be a date such as 2026-11-20/);
});
