import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyBaseline, readBaseline, runDrift, writeBaseline, DocubaseError } from '../src/index.js';

async function repo(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'docubase-drift-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

function git(root, args, date) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  if (date) env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = date;
  return execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8' });
}

const CODE = {
  'package.json': JSON.stringify({ name: 'thing', bin: { thing: 'src/cli.js' }, scripts: { build: 'x', 'test:unit': 'y' } }),
  'src/cli.js': "const flags = ['--verbose', '--out']; export function startServer() {} const k = process.env.THING_TOKEN;",
  'src/auth/login.js': 'export const login = 1;',
};

const rulesOf = (r) => r.findings.map((f) => f.rule);

test('a doc that tells the truth has no findings', async () => {
  const root = await repo({
    ...CODE,
    'docs/index.md': [
      '# Hello',
      'Run `npm run build` then `thing --verbose`. Set `THING_TOKEN`. Call `startServer()`.',
      'The entry point is `src/cli.js` and the folder `src/auth/`.',
      '```bash',
      'npx thing --out dist',
      'THING_TOKEN=abc thing --verbose',
      '```',
      '```json',
      '{ "ok": true }',
      '```',
    ].join('\n'),
  });
  const r = await runDrift(path.join(root, 'docs'));
  assert.deepEqual(r.findings, []);
  assert.equal(r.docs, 1);
});

test('each rule reports the right line', async () => {
  const root = await repo({
    ...CODE,
    'docs/index.md': [
      '---',
      'title: Hi',
      '---',
      '',
      'See `src/gone.js` and `npm run deploy` and `thing --nope`.', // line 5
      '',
      'Use `OLD_ENV_NAME` and `vanished()`.', // line 7
      '',
      '```json',
      '{ "a": }',
      '```',
      '',
      '```yaml',
      'a: [1, 2',
      '```',
      '',
      '```bash',
      'thing build --legacy-mode',
      '```',
      '[guide](../src/missing.js)',
    ].join('\n'),
  });
  const r = await runDrift(path.join(root, 'docs'));
  const find = (rule) => r.findings.filter((f) => f.rule === rule);
  assert.equal(find('missing-file')[0].line, 5);
  assert.equal(find('missing-file')[0].file, 'docs/index.md');
  assert.equal(find('missing-file').length, 2);
  assert.equal(find('missing-file')[1].line, 20);
  assert.equal(find('missing-script')[0].line, 5);
  assert.equal(find('missing-flag').map((f) => f.token).sort().join(), '--legacy-mode,--nope');
  assert.equal(find('missing-env')[0].line, 7);
  assert.equal(find('missing-symbol')[0].token, 'vanished');
  assert.equal(find('invalid-json')[0].line, 10);
  assert.equal(find('invalid-yaml')[0].line, 14);
  assert.equal(find('missing-env')[0].level, 'warn');
  assert.equal(find('missing-file')[0].level, 'error');
});

test('flags of other tools are not checked', async () => {
  const root = await repo({ ...CODE, 'docs/index.md': '```bash\ngit clone --depth 1 repo\nnpm install --save-dev x\n```\n' });
  assert.deepEqual((await runDrift(path.join(root, 'docs'))).findings, []);
});

test('docs do not prove themselves: a name that only appears in Markdown is still missing', async () => {
  const root = await repo({ ...CODE, 'README.md': 'Set `GHOST_VAR`.', 'docs/index.md': 'Set `GHOST_VAR`.' });
  assert.deepEqual(rulesOf(await runDrift(path.join(root, 'docs'))), ['missing-env']);
});

test('placeholders, drift-ignore and driftIgnore are respected', async () => {
  const root = await repo({
    ...CODE,
    'docs/a.md': '```json\n{ "key": ... }\n```\n```json drift-ignore\n{ nope\n```\n',
    'docs/b.md': '---\ndriftIgnore: true\n---\nSee `src/nothing.js`.',
  });
  assert.deepEqual((await runDrift(path.join(root, 'docs'))).findings, []);
});

test('rules can be turned off or lowered and tokens ignored with patterns', async () => {
  const root = await repo({
    ...CODE,
    'docs/docubase.config.json': JSON.stringify({ drift: { rules: { 'missing-file': 'off', 'missing-env': 'error' }, ignoreTokens: ['SKIP_*'] } }),
    'docs/index.md': 'Files `src/none.js`, env `NOT_THERE`, env `SKIP_THIS`.',
  });
  const r = await runDrift(path.join(root, 'docs'));
  assert.deepEqual(r.findings.map((f) => [f.rule, f.level]), [['missing-env', 'error']]);
});

test('bad drift config is a clear error', async () => {
  const root = await repo({ 'docs/docubase.config.json': JSON.stringify({ drift: { rules: { nonsense: 'error' } } }), 'docs/index.md': 'x' });
  await assert.rejects(runDrift(path.join(root, 'docs')), (e) => e instanceof DocubaseError && /not a rule/.test(e.message));
  const root2 = await repo({ 'docs/docubase.config.json': JSON.stringify({ drift: { rules: { stale: 'loud' } } }), 'docs/index.md': 'x' });
  await assert.rejects(runDrift(path.join(root2, 'docs')), /"error", "warn" or "off"/);
});

test('endpoints are checked against the OpenAPI file', async () => {
  const spec = 'openapi: 3.0.0\ninfo: { title: T, version: "1" }\npaths:\n  /users/{id}:\n    get: { responses: { "200": { description: ok } } }\n';
  const root = await repo({
    ...CODE,
    'docs/openapi.yaml': spec,
    'docs/docubase.config.json': JSON.stringify({ openapi: { spec: 'openapi.yaml' } }),
    'docs/index.md': 'Use `GET /users/:id` and `DELETE /users/{id}` and `GET /accounts`.',
  });
  const r = await runDrift(path.join(root, 'docs'));
  assert.deepEqual(r.findings.map((f) => f.token), ['DELETE /users/{id}', 'GET /accounts']);
});

test('covers: page goes stale when covered code changes after the page', async () => {
  const root = await repo({ ...CODE, 'docs/auth.md': '---\ncovers: src/auth/**\n---\nHow login works.' });
  git(root, ['init', '-q']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'first'], '2026-01-01T10:00:00Z');
  let r = await runDrift(path.join(root, 'docs'));
  assert.deepEqual(r.findings, []);

  await writeFile(path.join(root, 'src/auth/login.js'), 'export const login = 2;');
  git(root, ['commit', '-qam', 'change login flow'], '2026-02-01T10:00:00Z');
  r = await runDrift(path.join(root, 'docs'));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, 'stale');
  assert.match(r.findings[0].message, /2026-02-01.*change login flow.*2026-01-01/);

  await writeFile(path.join(root, 'docs/auth.md'), '---\ncovers: src/auth/**\n---\nHow login works now.');
  git(root, ['commit', '-qam', 'update docs'], '2026-02-02T10:00:00Z');
  assert.deepEqual((await runDrift(path.join(root, 'docs'))).findings, []);
});

test('covers patterns that match nothing are reported, even without git', async () => {
  const root = await repo({ ...CODE, 'docs/a.md': '---\ncovers:\n  - src/payments/**\n---\nText.' });
  const r = await runDrift(path.join(root, 'docs'));
  assert.deepEqual(rulesOf(r), ['covers-no-match']);
  assert.equal(r.findings[0].line, 1);
});

test('unsafe covers patterns are rejected', async () => {
  const root = await repo({ ...CODE, 'docs/a.md': '---\ncovers: ../../etc/**\n---\nText.' });
  await assert.rejects(runDrift(path.join(root, 'docs')), /cannot contain \.\./);
});

test('history checks explain why they were skipped', async () => {
  const root = await repo({ ...CODE, 'docs/a.md': '---\ncovers: src/auth/**\n---\nText.' });
  git(root, ['init', '-q']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'one'], '2026-01-01T10:00:00Z');
  const shallow = await runDrift(path.join(root, 'docs'), { git: async (args) => (args.includes('--is-shallow-repository') ? 'true\n' : 'true\n') });
  assert.match(shallow.notes[0], /shallow/);
  const off = await runDrift(path.join(root, 'docs'), { history: false });
  assert.match(off.notes[0], /--no-history/);
});

test('external links: dead ones are reported, protected and local ones are not', async () => {
  const root = await repo({
    ...CODE,
    'docs/index.md': ['[a](https://ok.test.dev/a)', '[b](https://gone.dev/b)', '[c](https://blocked.dev/c)', '[d](http://localhost:3000/x)', '[e](https://down.dev/e)', '[f](https://ok.test.dev/a)'].join('\n\n'),
  });
  const seen = [];
  const lookup = async (host) => [{ address: host.includes('private') ? '10.0.0.5' : '93.184.216.34' }];
  const fetchImpl = async (url, { method }) => {
    seen.push(`${method} ${url}`);
    if (url.includes('down.dev')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    const status = url.includes('gone.dev') ? 404 : url.includes('blocked.dev') ? 403 : 200;
    return { status, body: null, headers: new Headers() };
  };
  const off = await runDrift(path.join(root, 'docs'), { fetchImpl });
  assert.equal(off.findings.length, 0);
  assert.equal(seen.length, 0);
  const r = await runDrift(path.join(root, 'docs'), { external: true, fetchImpl, lookup });
  assert.deepEqual(r.findings.map((f) => f.token).sort(), ['https://down.dev/e', 'https://gone.dev/b']);
  assert.match(r.findings.find((f) => f.token.includes('down.dev')).message, /ENOTFOUND/);
  assert.ok(!seen.some((s) => s.includes('localhost')));
  assert.equal(seen.filter((s) => s.endsWith('ok.test.dev/a')).length, 1);
});

test('baseline hides known findings and reports resolved ones', async () => {
  const root = await repo({ ...CODE, 'docs/index.md': 'Old `src/a.js` and `src/b.js`.' });
  const first = await runDrift(path.join(root, 'docs'));
  const file = path.join(root, 'baseline.json');
  assert.equal(await writeBaseline(file, first.findings), 2);
  let split = applyBaseline(first.findings, await readBaseline(file));
  assert.equal(split.fresh.length, 0);
  assert.equal(split.known.length, 2);

  await writeFile(path.join(root, 'docs/index.md'), 'Old `src/a.js` and new `src/c.js`.');
  split = applyBaseline((await runDrift(path.join(root, 'docs'))).findings, await readBaseline(file));
  assert.deepEqual(split.fresh.map((f) => f.token), ['src/c.js']);
  assert.equal(split.resolved.length, 1);

  assert.equal((await readBaseline(path.join(root, 'nope.json'))).size, 0);
  await writeFile(file, '{"findings": 5}');
  await assert.rejects(readBaseline(file), /not a valid baseline/);
});

test('external links cannot be used to probe private networks, even through redirects', async () => {
  const root = await repo({
    ...CODE,
    'docs/index.md': ['[a](https://private.dev/a)', '[b](http://169.254.169.254/latest)', '[c](https://[::ffff:7f00:1]/x)', '[d](https://hop.dev/start)'].join('\n\n'),
  });
  const lookup = async (host) => [{ address: host.includes('private') ? '10.0.0.5' : '93.184.216.34' }];
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes('hop.dev')) return { status: 302, body: null, headers: new Headers({ location: 'https://private.dev/inner' }) };
    return { status: 200, body: null, headers: new Headers() };
  };
  const r = await runDrift(path.join(root, 'docs'), { external: true, fetchImpl, lookup });
  assert.equal(r.findings.length, 4);
  assert.ok(r.findings.every((f) => /private address/.test(f.message)));
  assert.deepEqual(seen, ['https://hop.dev/start']); // the redirect target was never requested
});

test('a baseline path outside the repository is refused', async () => {
  const root = await repo({ ...CODE, 'docs/docubase.config.json': JSON.stringify({ drift: { baseline: '../../../escape.json' } }), 'docs/index.md': 'x' });
  await assert.rejects(runDrift(path.join(root, 'docs')), /inside the repository/);
});
