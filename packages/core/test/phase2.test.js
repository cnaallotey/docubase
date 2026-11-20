import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSite, normalizeConfig, DocubaseError } from '../src/index.js';

async function makeDocs(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'docubase-p2-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

const SPEC = `
openapi: 3.0.3
info: { title: Pets API, version: 1.2.0, description: Manage pets. }
servers:
  - url: https://{env}.example.com/v1
    variables: { env: { default: api } }
  - url: /relative
tags:
  - name: Pets
    description: Everything about pets.
components:
  securitySchemes:
    token: { type: http, scheme: bearer }
  schemas:
    Pet:
      type: object
      required: [name]
      properties:
        id: { type: integer, format: int64 }
        name: { type: string, description: The pet name }
        parent: { $ref: '#/components/schemas/Pet' }
    Dog:
      allOf:
        - $ref: '#/components/schemas/Pet'
        - type: object
          properties:
            barks: { type: boolean }
paths:
  /pets:
    get:
      summary: List pets | all
      tags: [Pets]
      security: [{ token: [] }]
      parameters:
        - { name: limit, in: query, schema: { type: integer, default: 10 } }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: { type: array, items: { $ref: '#/components/schemas/Pet' } }
    post:
      summary: Create a <b>dog</b>
      tags: [Pets]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Dog' }
      responses:
        '201': { description: Created }
  /pets/{id}:
    get:
      summary: Get a pet
      parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
      responses: { '200': { description: OK } }
`;

const CONFIG = JSON.stringify({ title: 'Test', description: 'A test site', siteUrl: 'https://example.com', openapi: { spec: 'openapi.yaml' } });

async function apiSite(spec = SPEC, extra = {}) {
  const root = await makeDocs({ 'docubase.config.json': CONFIG, 'index.md': '# Home\n\nSee the [API](./api/index.md).', 'openapi.yaml': spec, ...extra });
  return loadSite(root);
}

test('an OpenAPI file becomes an overview and one page per tag that pass the normal link checks', async () => {
  const site = await apiSite();
  assert.deepEqual(site.pages.map((p) => p.url).sort(), ['/', '/api/', '/api/endpoints/', '/api/pets/']);
  assert.deepEqual(site.warnings, []);
  assert.ok(site.pages.filter((p) => p.url.startsWith('/api')).every((p) => p.generated && !p.editUrl));
  const group = site.nav.tree.find((e) => e.type === 'group');
  assert.equal(group.label, 'API reference');
  assert.equal(site.pages.find((p) => p.url === '/api/').title, 'Pets API');
});

test('operations carry what the playground needs and server variables are filled in', async () => {
  const site = await apiSite();
  const pets = site.pages.find((p) => p.slug === 'api/pets');
  assert.equal(pets.api.operations.length, 2);
  const [list, create] = pets.api.operations;
  assert.equal(list.method, 'GET');
  assert.deepEqual(list.servers, ['https://api.example.com/v1']);
  assert.deepEqual(list.serverHints, ['/relative'], 'relative servers are not offered as a target');
  assert.deepEqual(list.security, { kind: 'bearer', names: ['token'], scheme: 'token' });
  assert.deepEqual(list.parameters, [{ name: 'limit', in: 'query', required: false, example: '10' }]);
  assert.equal(create.body.contentType, 'application/json');
  // A self reference is expanded once, then cut off, so the example stays finite.
  assert.deepEqual(JSON.parse(create.body.text), { id: 0, name: 'string', parent: { id: 0, name: 'string', parent: null }, barks: true });
  assert.match(pets.html, /data-operation="0"/);
  assert.match(pets.html, /data-operation="1"/);
});

test('parameters are only prefilled with values the spec provides', async () => {
  const spec = `
openapi: 3.0.0
info: { title: T, version: '1' }
paths:
  /x/{id}:
    get:
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
        - { name: q, in: query, schema: { type: string } }
        - { name: kind, in: query, schema: { type: string, enum: [a, b] } }
        - { name: n, in: query, example: 7, schema: { type: integer } }
        - { name: flag, in: query, schema: { type: boolean } }
      responses: { '200': { description: ok } }
`;
  const site = await apiSite(spec);
  const op = site.pages.find((p) => p.slug === 'api/endpoints').api.operations[0];
  assert.deepEqual(Object.fromEntries(op.parameters.map((p) => [p.name, p.example])), { id: '', q: '', kind: 'a', n: '7', flag: '' });
});

test('summaries from the spec cannot inject HTML or break tables', async () => {
  const site = await apiSite();
  const pets = site.pages.find((p) => p.slug === 'api/pets');
  assert.ok(!pets.html.includes('<b>dog'), 'tags in a summary are escaped');
  assert.match(pets.html, /Create a &#x3C;b>dog&#x3C;\/b>/);
  const overview = site.pages.find((p) => p.url === '/api/');
  assert.match(overview.html, /List pets \| all/);
});

test('reference cycles, allOf, missing and external references are handled without hanging', async () => {
  const spec = `
openapi: 3.1.0
info: { title: T, version: '1' }
paths:
  /a:
    get:
      summary: A
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Node' }
        '404':
          description: missing
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Nope' }
        '500':
          description: far
          content:
            application/json:
              schema: { $ref: 'other.yaml#/Thing' }
components:
  schemas:
    Node:
      type: object
      properties:
        next: { $ref: '#/components/schemas/Node' }
        value: { type: string }
`;
  const site = await apiSite(spec);
  const warnings = site.warnings.join('\n');
  assert.match(warnings, /#\/components\/schemas\/Nope.*does not exist/);
  assert.match(warnings, /other\.yaml.*outside the spec file/);
  assert.ok(site.pages.some((p) => p.slug === 'api/endpoints'));
});

test('bad specs fail with a clear message', async () => {
  const cases = [
    ['swagger: "2.0"\ninfo: {}\npaths: {}', /Swagger 2.0 is not supported/],
    ['hello: world', /expected an OpenAPI 3.x document/],
    ['openapi: 3.0.0\ninfo: {title: t, version: "1"}\npaths: {}', /no operations/],
    ['openapi: [', /could not parse/],
  ];
  for (const [spec, pattern] of cases) {
    await assert.rejects(apiSite(spec), (error) => error instanceof DocubaseError && pattern.test(error.message), pattern.toString());
  }
  const root = await makeDocs({ 'docubase.config.json': JSON.stringify({ openapi: { spec: 'missing.yaml' } }), 'index.md': '# x' });
  await assert.rejects(loadSite(root), /file not found/);
});

test('a hand written page that collides with a generated page is reported', async () => {
  const root = await makeDocs({
    'docubase.config.json': CONFIG,
    'openapi.yaml': SPEC,
    'api/pets.md': '# Mine',
    'index.md': '# Home',
  });
  await assert.rejects(loadSite(root), /both produce the page "\/api\/pets\/"/);
});

test('llms.txt links to Markdown pages, and llms-full.txt carries every visible page without playground markers', async () => {
  const site = await apiSite();
  const { llmsTxt, llmsFull } = site.agents;
  assert.match(llmsTxt, /^# Test\n\n> A test site/);
  assert.match(llmsTxt, /\(https:\/\/example\.com\/api\/pets\.md\)/);
  assert.match(llmsTxt, /\(https:\/\/example\.com\/llms-full\.txt\)/);
  assert.ok(!llmsFull.includes('::try-it'));
  assert.match(llmsFull, /Source: https:\/\/example\.com\/api\/pets\//);
  assert.match(llmsFull, /## Get a pet/);
});

test('llms.txt uses relative links without siteUrl and leaves hidden pages out', async () => {
  const root = await makeDocs({
    'docubase.config.json': JSON.stringify({ base: '/docs/' }),
    'index.md': '# Home',
    'secret.md': '---\nhidden: true\n---\n# Secret\n\nplans',
  });
  const site = await loadSite(root);
  assert.match(site.agents.llmsTxt, /\(\/docs\/index\.md\)/);
  assert.ok(!site.agents.llmsTxt.includes('secret'));
  assert.ok(!site.agents.llmsFull.includes('plans'));
  assert.ok(!site.agents.chunks.some((c) => c.text.includes('plans')));
});

test('assistant chunks use the same ids as the browser search index', async () => {
  const site = await apiSite();
  const ids = new Set(site.search.index.documentIds ? Object.values(site.search.index.documentIds) : []);
  assert.ok(site.agents.chunks.length > 0);
  for (const chunk of site.agents.chunks) assert.ok(ids.has(chunk.id), `${chunk.id} is in the search index`);
  assert.ok(site.agents.chunks.every((c) => c.text.length <= 4000));
});

test('config: keys are refused, defaults survive a second pass, and bad values are explained', () => {
  assert.throws(() => normalizeConfig({ assistant: { enabled: true, model: 'm', apiKey: 'sk-x' } }), /Never put keys in this file/);
  assert.throws(() => normalizeConfig({ assistant: { enabled: true, model: 'm', accessToken: 'x' } }), /not allowed/);
  assert.throws(() => normalizeConfig({ assistant: { enabled: true } }), /model" is required/);
  assert.throws(() => normalizeConfig({ assistant: { provider: 'other' } }), /anthropic" or "openai"/);
  assert.throws(() => normalizeConfig({ assistant: { baseUrl: 'ftp://x' } }), /http or https/);
  assert.throws(() => normalizeConfig({ openapi: { spec: '../secret.yaml' } }), /inside the docs folder/);
  assert.throws(() => normalizeConfig({ siteUrl: 'javascript:alert(1)' }), /full http\(s\) URL/);

  const once = normalizeConfig({ siteUrl: 'https://a.com/', openapi: { spec: 'o.yaml' }, assistant: { enabled: true, model: 'm' } });
  assert.equal(once.siteUrl, 'https://a.com');
  const twice = normalizeConfig({ ...once, base: '/x/' });
  assert.deepEqual(twice.assistant, once.assistant);
  assert.deepEqual(twice.openapi, once.openapi);
  assert.equal(normalizeConfig({}).assistant.model, null);
  assert.equal(normalizeConfig({ assistant: { model: null } }).assistant.enabled, false);
});
