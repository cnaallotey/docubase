import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import MiniSearch from 'minisearch';
import { compilePage, loadSite, normalizeConfig, DocubaseError } from '../src/index.js';

async function makeDocs(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'docubase-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

test('frontmatter title wins, otherwise the first h1 becomes the title and is removed from the body', async () => {
  const a = await compilePage({ source: 'a.md', raw: '---\ntitle: From frontmatter\n---\n# Heading\n\nBody text.' });
  assert.equal(a.title, 'From frontmatter');

  const b = await compilePage({ source: 'b.md', raw: '# From heading\n\nBody text.' });
  assert.equal(b.title, 'From heading');
  assert.ok(!b.html.includes('<h1'), 'h1 should be stripped so the theme can draw the title once');

  const c = await compilePage({ source: 'getting-started.md', raw: 'Just text.' });
  assert.equal(c.title, 'Getting Started');
});

test('invalid frontmatter types are rejected with the file name', async () => {
  await assert.rejects(
    compilePage({ source: 'x.md', raw: '---\norder: first\n---\nHi' }),
    (error) => error instanceof DocubaseError && error.message.includes('x.md') && error.message.includes('order'),
  );
});

test('JavaScript frontmatter is refused instead of executed', async () => {
  globalThis.__docubase_pwned = false;
  await assert.rejects(
    compilePage({ source: 'evil.md', raw: '---js\n{ title: (globalThis.__docubase_pwned = true, "x") }\n---\nHi' }),
    DocubaseError,
  );
  assert.equal(globalThis.__docubase_pwned, false);
});

test('callouts render with a default or custom title', async () => {
  const page = await compilePage({
    source: 'c.md',
    raw: ':::note\nPlain note.\n:::\n\n:::warning[Careful]\nCustom title.\n:::\n',
  });
  assert.match(page.html, /<div class="callout callout-note" role="note"><p class="callout-title">Note<\/p>/);
  assert.match(page.html, /callout-warning/);
  assert.match(page.html, /<p class="callout-title">Careful<\/p>/);
});

test('tabs render panels with labels', async () => {
  const page = await compilePage({
    source: 't.md',
    raw: '::::tabs\n:::tab[npm]\n`npm i docubase`\n:::\n:::tab[pnpm]\n`pnpm add docubase`\n:::\n::::\n',
  });
  assert.match(page.html, /<div class="tabs">/);
  assert.match(page.html, /<div class="tab-panel" data-label="npm">/);
  assert.match(page.html, /data-label="pnpm"/);
});

test('code blocks get syntax highlighting classes', async () => {
  const page = await compilePage({ source: 'code.md', raw: '```js\nconst a = 1;\n```\n' });
  assert.match(page.html, /hljs-keyword/);
});

test('text that looks like a directive is kept as text', async () => {
  const page = await compilePage({ source: 'd.md', raw: 'Call me at foo:bar or :smile later.\n\n:::mystery\nHello\n:::\n' });
  assert.match(page.html, /foo:bar/);
  assert.match(page.html, /:smile/);
  assert.ok(page.warnings.some((w) => w.includes('Unknown directive')));
});

test('raw HTML is removed and reported', async () => {
  const page = await compilePage({ source: 'h.md', raw: 'Before\n\n<script>alert(1)</script>\n\nAfter\n' });
  assert.ok(!page.html.includes('<script'));
  assert.ok(page.warnings.some((w) => w.includes('raw HTML')));
});

test('relative markdown links become site urls and images resolve from the page folder', async () => {
  const page = await compilePage({
    source: 'guides/writing.md',
    raw: '[Start](../getting-started.md#install) and [Self](#top) and [Out](https://example.com)\n\n![Logo](./img/logo.png)\n',
    base: '/docs/',
  });
  assert.match(page.html, /href="\/docs\/getting-started\/#install"/);
  assert.match(page.html, /href="#top"/);
  assert.match(page.html, /rel="noopener noreferrer"/);
  assert.match(page.html, /src="\/docs\/guides\/img\/logo.png"/);
  assert.deepEqual(page.images.map((i) => i.path), ['guides/img/logo.png']);
});

test('headings, sections and anchors are collected', async () => {
  const page = await compilePage({
    source: 'p.md',
    raw: 'Intro text.\n\n## First\n\nAlpha.\n\n### Deep\n\nBeta.\n\n## Second\n\nGamma.\n',
  });
  assert.deepEqual(page.headings.map((h) => [h.depth, h.id]), [[2, 'first'], [3, 'deep'], [2, 'second']]);
  assert.deepEqual(page.sections.map((s) => s.id), ['', 'first', 'second']);
  assert.match(page.html, /<a class="anchor" href="#first" aria-label="Link to this section">#<\/a>/);
  assert.equal(page.description, 'Intro text.');
});

test('navigation follows folders, frontmatter order and _meta.json', async () => {
  const root = await makeDocs({
    'index.md': '---\ntitle: Home\n---\nWelcome',
    'zeta.md': '---\ntitle: Zeta\norder: 1\n---\nz',
    'alpha.md': '---\ntitle: Alpha\norder: 2\n---\na',
    'guides/index.md': '---\ntitle: Guides overview\n---\ng',
    'guides/two.md': '---\ntitle: Two\norder: 2\n---\n2',
    'guides/one.md': '---\ntitle: One\norder: 1\n---\n1',
    'guides/_meta.json': '{ "label": "How to", "order": 5 }',
    'secret.md': '---\nhidden: true\n---\nhidden',
  });
  const site = await loadSite(root);
  const labels = site.nav.tree.map((e) => (e.type === 'group' ? `group:${e.label}` : e.title));
  assert.deepEqual(labels, ['Home', 'Zeta', 'Alpha', 'group:How to']);
  const group = site.nav.tree.find((e) => e.type === 'group');
  assert.deepEqual(group.items.map((e) => e.title), ['Guides overview', 'One', 'Two']);
  assert.ok(!site.nav.flat.some((e) => e.title === 'secret'), 'hidden pages stay out of the sidebar');

  const home = site.pages.find((p) => p.slug === '');
  assert.equal(home.url, '/');
  assert.equal(home.prev, null);
  assert.equal(home.next.title, 'Zeta');
});

test('an explicit sidebar in the config replaces the automatic one and checks the slugs', async () => {
  const root = await makeDocs({
    'docubase.config.json': JSON.stringify({ sidebar: ['a', { group: 'More', items: ['b'] }] }),
    'a.md': '# A',
    'b.md': '# B',
  });
  const site = await loadSite(root);
  assert.equal(site.nav.tree[0].title, 'A');
  assert.equal(site.nav.tree[1].label, 'More');

  const bad = await makeDocs({
    'docubase.config.json': JSON.stringify({ sidebar: ['missing'] }),
    'a.md': '# A',
  });
  await assert.rejects(loadSite(bad), /do not exist: missing/);
});

test('broken links, missing anchors and missing images are reported', async () => {
  const root = await makeDocs({
    'a.md': '# A\n\n[ok](./b.md#real) [bad page](./nope.md) [bad anchor](./b.md#ghost) ![x](./missing.png)\n',
    'b.md': '# B\n\n## Real\n\ntext\n',
  });
  const site = await loadSite(root);
  const joined = site.warnings.join('\n');
  assert.match(joined, /broken link "\.\/nope\.md"/);
  assert.match(joined, /heading that does not exist/);
  assert.match(joined, /image "missing\.png" was not found/);
  assert.ok(!joined.includes('"./b.md#real"'));
});

test('two files that map to the same url are an error', async () => {
  const root = await makeDocs({ 'a.md': '# A', 'a.mdx': '# A again' });
  await assert.rejects(loadSite(root), /both produce the page/);
});

test('search finds a section, ranks title matches first and supports prefix typing', async () => {
  const root = await makeDocs({
    'index.md': '# Home\n\nWelcome to the docs.',
    'deploy.md': '# Deploying\n\nIntro.\n\n## Docker image\n\nRun the container with the published image.\n',
    'search.md': '# Searching\n\n## Fuzzy matching\n\nTypos like dockr still find results.\n',
  });
  const site = await loadSite(root);
  const mini = MiniSearch.loadJS(site.search.index, site.search.options);

  const exact = mini.search('docker');
  assert.equal(exact[0].url, '/deploy/#docker-image');

  const prefix = mini.search('deplo');
  assert.equal(prefix[0].title, 'Deploying');

  const fuzzy = mini.search('dockr');
  assert.ok(fuzzy.length > 0);
});

test('hidden pages are not searchable', async () => {
  const root = await makeDocs({ 'a.md': '# A\n\nvisible words', 'h.md': '---\nhidden: true\n---\n# H\n\nsecretword' });
  const site = await loadSite(root);
  const mini = MiniSearch.loadJS(site.search.index, site.search.options);
  assert.equal(mini.search('secretword').length, 0);
  assert.ok(mini.search('visible').length > 0);
});

test('config validation gives readable errors', () => {
  assert.throws(() => normalizeConfig({ title: 5 }), /"title" must be a string/);
  assert.throws(() => normalizeConfig({ theme: { accent: 'red; } body { display:none' } }), /hex colour/);
  assert.throws(() => normalizeConfig({ editUrl: 'ftp://x/{path}' }), /http/);
  assert.throws(() => normalizeConfig({ editUrl: 'https://x/edit' }), /\{path\}/);
  assert.throws(() => normalizeConfig({ links: [{ label: 'x', href: 'javascript:alert(1)' }] }), /javascript/);
  assert.equal(normalizeConfig({ base: 'docs' }).base, '/docs/');
});

test('social image and twitter settings are checked, and pages may name their own image', async () => {
  assert.equal(normalizeConfig({ socialImage: '/og/{page}.png' }).socialImage, '/og/{page}.png');
  assert.equal(normalizeConfig({ socialImage: 'https://cdn.example.com/og.png' }).socialImage, 'https://cdn.example.com/og.png');
  assert.throws(() => normalizeConfig({ socialImage: 'javascript:alert(1)' }), /http\(s\) URL/);
  assert.throws(() => normalizeConfig({ socialImage: '../secret.png' }), /inside the site/);
  assert.throws(() => normalizeConfig({ socialImage: '//evil.example/og.png' }), /inside the site/);
  assert.equal(normalizeConfig({ twitter: 'docubase' }).twitter, '@docubase');
  assert.throws(() => normalizeConfig({ twitter: 'not a handle' }), /handle/);

  const page = await compilePage({ source: 'a.md', raw: '---\nimage: images/a.png\n---\n# A' });
  assert.equal(page.image, 'images/a.png');
  await assert.rejects(compilePage({ source: 'b.md', raw: '---\nimage: 5\n---\n# B' }), /b\.md: frontmatter "image"/);
});
