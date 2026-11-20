import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The fixture sits inside the repo so Node can resolve nuxt and @docubase/nuxt from the workspace.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, `.fixture-${process.pid}`);
const OUT = path.join(APP, '.output', 'public');
const NUXT_BIN = path.resolve(HERE, '../../../node_modules/nuxt/bin/nuxt.mjs');

const SPEC = `
openapi: 3.0.3
info: { title: Hostile API, version: '1' }
paths:
  /things:
    get:
      summary: '</script><img src=x onerror=alert(1)>'
      parameters: [{ name: q, in: query, schema: { type: string, default: '</script>' } }]
      responses: { '200': { description: ok } }
`;

const read = (file) => readFile(path.join(OUT, file), 'utf8');
const exists = (file) => access(path.join(OUT, file)).then(() => true, () => false);

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NUXT_BIN, ...args], { cwd: APP, env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1', CI: '1' } });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => (code === 0 ? resolve(output) : reject(new Error(`nuxt exited with ${code}\n${output.slice(-3000)}`))));
  });
}

before(async () => {
  await mkdir(path.join(APP, 'docs', 'guides'), { recursive: true });
  await writeFile(path.join(APP, 'nuxt.config.js'), "export default defineNuxtConfig({ compatibilityDate: '2025-07-15', modules: ['@docubase/nuxt'], docubase: { dir: 'docs' }, telemetry: false });\n");
  await writeFile(path.join(APP, 'docs', 'docubase.config.json'), JSON.stringify({
    title: 'Fixture',
    description: 'A fixture site',
    links: [{ label: 'Home page', href: 'https://example.com' }],
    openapi: { spec: 'openapi.yaml' },
    assistant: { enabled: true, provider: 'anthropic', model: 'm' },
    theme: { accent: '#0f766e' },
  }));
  await writeFile(path.join(APP, 'docs', 'openapi.yaml'), SPEC);
  await writeFile(path.join(APP, 'docs', 'index.md'), '# Welcome\n\nHello from the fixture.\n\n:::note[Heads up]\nA callout.\n:::\n');
  await writeFile(path.join(APP, 'docs', 'guides', 'setup.md'), '---\ntitle: "Setup </title><script>alert(1)</script> \\" onmouseover=\\"alert(3)"\ndescription: How to set up\n---\n\n## Install\n\nRun `npm install`.\n\n<script>alert("raw html")</script>\n');
  await writeFile(path.join(APP, 'docs', 'hidden.md'), '---\nhidden: true\n---\n# Hidden\n\nzebra plan\n');
  await run(['generate']);
});

after(async () => {
  await rm(APP, { recursive: true, force: true });
});

test('generate writes a page for every docs page, with the Vue theme markup', async () => {
  for (const file of ['index.html', 'guides/setup/index.html', 'api/index.html', 'api/endpoints/index.html', 'hidden/index.html', '404.html']) {
    assert.ok(await exists(file), `${file} exists`);
  }
  const home = await read('index.html');
  assert.match(home, /<html[^>]* lang="en" data-base="\/" data-v="[0-9a-f]{8}"/);
  assert.match(home, /<title>Fixture<\/title>/);
  assert.match(home, /<h1 class="page-title">Welcome<\/h1>/);
  assert.match(home, /<div class="callout callout-note"/);
  assert.match(home, /--accent:#0f766e/);
  assert.match(home, /<a href="https:\/\/example\.com" rel="noopener noreferrer">Home page<\/a>/);
  assert.match(home, /href="\/assets\/docubase\.css\?v=[0-9a-f]{8}"/);
  assert.match(home, /<link rel="alternate" type="text\/markdown" href="\/index\.md">/);
  const setup = await read('guides/setup/index.html');
  assert.match(setup, /aria-current="page"[^>]*>Setup/, 'current page is marked in the sidebar');
});

test('the assistant button, dialog and endpoint are present only because the config turned it on', async () => {
  const home = await read('index.html');
  assert.match(home, /data-ask="\/__docubase\/ask"/);
  assert.match(home, /id="ask-dialog"/);
  assert.match(home, /class="ask-btn"/);
  assert.ok(await exists('docubase-chunks.json'));
  const chunks = JSON.parse(await read('docubase-chunks.json'));
  assert.ok(chunks.length > 0 && chunks.every((c) => !c.text.includes('zebra')), 'hidden pages are not in the chunks');
});

test('Markdown routes, llms files and the search index are served next to the pages', async () => {
  assert.match(await read('guides/setup.md'), /^# Setup/);
  const llms = await read('llms.txt');
  assert.match(llms, /^# Fixture/);
  assert.match(llms, /\(\/guides\/setup\.md\)/);
  assert.ok(!llms.includes('hidden'));
  assert.ok(!(await read('llms-full.txt')).includes('zebra'));
  const search = JSON.parse(await read('search-index.json'));
  assert.ok(search.index && search.options);
  assert.ok(await exists('assets/docubase.js') && await exists('assets/docubase.css') && await exists('assets/minisearch.js'));
});

test('hostile content in titles, raw HTML and the spec cannot break out of the page', async () => {
  const setup = await read('guides/setup/index.html');
  // Quoted attribute values are blanked first, so a harmless "<" inside content="..." does not count.
  const markup = setup.replace(/="[^"]*"/g, '=""');
  assert.ok(!markup.includes('<script>alert(1)'), 'a title cannot inject a script');
  assert.ok(!/<[a-z][^>]*\sonmouseover=/i.test(markup), 'a quote in a title cannot add an attribute to any tag');
  assert.match(setup, /<title>Setup &lt;&#x2F;title&gt;/, 'the page title is escaped');
  assert.ok(!setup.includes('alert("raw html")'), 'raw HTML in Markdown is removed');

  const api = await read('api/endpoints/index.html');
  assert.ok(!api.includes('<img src=x'), 'a summary cannot inject an image');
  const attr = api.match(/<div id="docubase-api" hidden data-operations="([^"]*)"/);
  assert.ok(attr, 'operation data is embedded in an attribute');
  assert.ok(!attr[1].includes('<'), 'the attribute value is escaped');
  const unescape = (v) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const ops = JSON.parse(unescape(attr[1]));
  assert.equal(ops[0].parameters[0].example, '</script>');
});

test('pages can be reached without a reload: payloads are prerendered and the client knows the docs addresses', async () => {
  assert.ok(await exists('guides/setup/_payload.json'), 'each page has a payload for client side navigation');
  assert.match(await read('guides/setup/_payload.json'), /Run /);
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(path.join(OUT, '_nuxt'))).filter((f) => f.endsWith('.js'));
  const code = (await Promise.all(files.map((f) => read(path.join('_nuxt', f))))).join('\n');
  assert.match(code, /["'`]\/guides\/setup\/["'`]/, 'the client bundle lists the docs addresses');
  const home = await read('index.html');
  assert.match(home, /<main id="content" class="content" tabindex="-1">/, 'focus can move to the new content');
});

test('page HTML is rendered on the server and is not shipped inside client JavaScript', async () => {
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(path.join(OUT, '_nuxt'))).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const code = await read(path.join('_nuxt', file));
    assert.ok(!code.includes('Hello from the fixture'), `${file} does not contain page content`);
  }
});
