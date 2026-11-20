import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { dev } from '../src/dev.js';

const EXAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/docs');

function capture() {
  const lines = { log: [], warn: [], error: [] };
  return {
    lines,
    log: { log: (m) => lines.log.push(String(m)), warn: (m) => lines.warn.push(String(m)), error: (m) => lines.error.push(String(m)) },
  };
}

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'docubase-cli-'));
}

async function docs(files) {
  const root = await tempDir();
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

test('build writes pages, assets, search index and a 404 page', async () => {
  const out = await tempDir();
  const c = capture();
  const code = await main(['build', EXAMPLE, '--out', out, '--strict'], c);
  assert.equal(code, 0, c.lines.error.join('\n'));
  assert.deepEqual(c.lines.warn, [], 'the example docs must build without warnings');

  for (const file of [
    'index.html', 'getting-started/index.html', 'guides/writing/index.html', '404.html',
    'search-index.json', 'assets/docubase.css', 'assets/docubase.js', 'assets/minisearch.js', 'guides/img/folder.svg',
  ]) {
    await readFile(path.join(out, file));
  }
  const index = JSON.parse(await readFile(path.join(out, 'search-index.json'), 'utf8'));
  assert.ok(index.options.fields.includes('text'));

  const html = await readFile(path.join(out, 'guides/writing/index.html'), 'utf8');
  assert.match(html, /<title>Writing pages · Docubase<\/title>/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /<link rel="icon" href="data:,">/);
});

test('titles and config values are escaped in the page shell', async () => {
  const root = await docs({
    'docubase.config.json': JSON.stringify({ title: '<img src=x onerror=alert(1)>', footer: '"><script>1</script>' }),
    'index.md': '---\ntitle: <b>Bold</b> & "quoted"\n---\nHello',
  });
  const out = await tempDir();
  assert.equal(await main(['build', root, '--out', out], capture()), 0);
  const html = await readFile(path.join(out, 'index.html'), 'utf8');
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<script>1</script>'));
  assert.match(html, /&lt;b&gt;Bold&lt;\/b&gt; &amp; &quot;quoted&quot;/);
});

test('--strict fails on warnings, a normal build only prints them', async () => {
  const root = await docs({ 'index.md': '# Home\n\n[gone](./missing.md)\n' });
  const c1 = capture();
  assert.equal(await main(['build', root, '--out', await tempDir()], c1), 0);
  assert.ok(c1.lines.warn.some((w) => w.includes('broken link')));

  const c2 = capture();
  assert.equal(await main(['build', root, '--out', await tempDir(), '--strict'], c2), 1);
  assert.ok(c2.lines.error.some((e) => e.includes('--strict')));
});

test('build refuses to wipe a folder it did not create', async () => {
  const root = await docs({ 'index.md': '# Home' });
  const precious = await docs({ 'my-notes.txt': 'do not delete' });
  const c = capture();
  assert.equal(await main(['build', root, '--out', precious], c), 1);
  assert.match(c.lines.error.join('\n'), /not empty and was not created by Docubase/);
  assert.deepEqual(await readdir(precious), ['my-notes.txt']);
});

test('build refuses an output folder that contains the docs', async () => {
  const root = await docs({ 'index.md': '# Home' });
  const c = capture();
  assert.equal(await main(['build', root, '--out', path.dirname(root)], c), 1);
  assert.match(c.lines.error.join('\n'), /contains your docs folder/);
  assert.equal(await main(['build', root, '--out', root], capture()), 1);
});

test('a second build over its own output works', async () => {
  const root = await docs({ 'index.md': '# Home' });
  const out = await tempDir();
  assert.equal(await main(['build', root, '--out', out], capture()), 0);
  assert.equal(await main(['build', root, '--out', out], capture()), 0);
});

test('the default output folder inside the docs folder is not read back in as pages', async () => {
  const root = await docs({ 'index.md': '# Home', 'a.md': '# A' });
  assert.equal(await main(['build', root], capture()), 0);
  const c = capture();
  assert.equal(await main(['build', root, '--strict'], c), 0, c.lines.error.join('\n'));
});

test('public folder is copied to the site root and favicon is linked', async () => {
  const root = await docs({ 'index.md': '# Home', 'public/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'public/robots.txt': 'User-agent: *' });
  const out = await tempDir();
  assert.equal(await main(['build', root, '--out', out], capture()), 0);
  assert.equal(await readFile(path.join(out, 'robots.txt'), 'utf8'), 'User-agent: *');
  assert.match(await readFile(path.join(out, 'index.html'), 'utf8'), /<link rel="icon" href="\/favicon.svg">/);
});

test('base path is applied to links, assets and search', async () => {
  const root = await docs({
    'docubase.config.json': JSON.stringify({ base: '/docs/' }),
    'index.md': '# Home\n\n[A](./a.md)',
    'a.md': '# A',
  });
  const out = await tempDir();
  assert.equal(await main(['build', root, '--out', out], capture()), 0);
  const html = await readFile(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /data-base="\/docs\/"/);
  assert.match(html, /href="\/docs\/assets\/docubase.css/);
  assert.match(html, /href="\/docs\/a\/"/);
});

test('help, version, unknown command and bad flags', async () => {
  const c1 = capture();
  assert.equal(await main(['--help'], c1), 0);
  assert.match(c1.lines.log.join('\n'), /docubase build/);

  const c2 = capture();
  assert.equal(await main(['--version'], c2), 0);
  assert.match(c2.lines.log[0], /^\d+\.\d+\.\d+/);

  assert.equal(await main(['nope'], capture()), 1);
  assert.equal(await main(['build', '--wat'], capture()), 1);
  const c3 = capture();
  assert.equal(await main(['build', '/definitely/not/a/folder'], c3), 1);
  assert.match(c3.lines.error.join('\n'), /not a folder/);
});

test('invalid config stops the build with a readable message', async () => {
  const root = await docs({ 'docubase.config.json': '{ "title": 7 }', 'index.md': '# Home' });
  const c = capture();
  assert.equal(await main(['build', root, '--out', await tempDir()], c), 1);
  assert.match(c.lines.error.join('\n'), /"title" must be a string/);
});

test('dev server serves pages, injects live reload, rebuilds on change and blocks path traversal', async () => {
  const root = await docs({ 'index.md': '# Home\n\nfirst version', 'docubase.config.json': '{ "base": "/sub/" }' });
  const c = capture();
  const server = await dev(root, { port: 0, log: c.log });
  try {
    const home = await fetch(server.url);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /EventSource/);
    assert.match(html, /first version/);
    assert.match(html, /href="\/assets\/docubase.css/, 'dev ignores the production base path');

    assert.equal((await fetch(`${server.url}missing/`)).status, 404);
    assert.equal((await fetch(`${server.url}%2e%2e/%2e%2e/etc/passwd`)).status, 404);
    assert.equal((await fetch(`${server.url}%00`)).status, 404);
    assert.equal((await fetch(`${server.url}assets/docubase.js`)).status, 200);

    await writeFile(path.join(root, 'index.md'), '# Home\n\nsecond version');
    let updated = false;
    for (let i = 0; i < 40 && !updated; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      updated = (await (await fetch(server.url)).text()).includes('second version');
    }
    assert.ok(updated, 'page should update after the file changes');

    await writeFile(path.join(root, 'index.md'), '---\norder: nope\n---\n# Broken');
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(c.lines.error.some((e) => e.includes('order')), 'build errors are reported');
    assert.equal((await fetch(server.url)).status, 200, 'the last good build keeps being served');
  } finally {
    await server.close();
  }
});
