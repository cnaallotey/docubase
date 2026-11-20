import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';

const EXAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/docs');

function capture() {
  const lines = [];
  const push = (m) => lines.push(String(m));
  return { lines, log: { log: push, warn: push, error: push } };
}

async function project(doc) {
  const root = await mkdtemp(path.join(tmpdir(), 'docubase-check-'));
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'y' } }));
  await writeFile(path.join(root, 'src/app.js'), 'export const app = 1;');
  await writeFile(path.join(root, 'docs/index.md'), doc);
  return path.join(root, 'docs');
}

test('the example docs have no drift', async () => {
  const out = capture();
  assert.equal(await main(['check', EXAMPLE], out), 0);
  assert.match(out.lines.join('\n'), /0 errors, 0 warnings/);
});

test('text output lists file, line, rule and message and exits 1 on errors', async () => {
  const dir = await project('Intro.\n\nSee `src/missing.js`.\n');
  const out = capture();
  assert.equal(await main(['check', dir], out), 1);
  const text = out.lines.join('\n');
  assert.match(text, /docs\/index\.md/);
  assert.match(text, /3\s+error\s+missing-file\s+src\/missing\.js does not exist/);
  assert.match(text, /1 error, 0 warnings/);
});

test('warnings pass by default and fail with --fail-on warn', async () => {
  const dir = await project('Set `NOT_READ_ANYWHERE`.\n');
  assert.equal(await main(['check', dir], capture()), 0);
  assert.equal(await main(['check', dir, '--fail-on', 'warn'], capture()), 1);
  assert.equal(await main(['check', dir, '--fail-on', 'never'], capture()), 0);
});

test('json output is machine readable', async () => {
  const dir = await project('See `src/missing.js`.\n');
  const out = capture();
  await main(['check', dir, '--format', 'json'], out);
  const data = JSON.parse(out.lines.join('\n'));
  assert.equal(data.findings[0].rule, 'missing-file');
  assert.equal(data.findings[0].file, 'docs/index.md');
  assert.equal(data.findings[0].line, 1);
});

test('github output writes annotations and escapes special characters', async () => {
  const dir = await project('See `src/missing.js`.\n');
  const out = capture();
  assert.equal(await main(['check', dir, '--format', 'github'], out), 1);
  assert.equal(out.lines[0], '::error file=docs/index.md,line=1,title=docs drift%3A missing-file::src/missing.js does not exist in the repository.');
});

test('a baseline lets existing drift pass while new drift fails', async () => {
  const dir = await project('See `src/old.js`.\n');
  const out = capture();
  assert.equal(await main(['check', dir, '--update-baseline'], out), 0);
  assert.match(out.lines.join('\n'), /Wrote 1 finding/);
  const file = path.join(dir, '.docubase-drift-baseline.json');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).findings.length, 1);

  await writeFile(path.join(dir, 'docubase.config.json'), JSON.stringify({ drift: { baseline: '.docubase-drift-baseline.json' } }));
  const again = capture();
  assert.equal(await main(['check', dir], again), 0);
  assert.match(again.lines.join('\n'), /1 in the baseline/);

  await writeFile(path.join(dir, 'index.md'), 'See `src/old.js` and `src/new.js`.\n');
  const third = capture();
  assert.equal(await main(['check', dir], third), 1);
  assert.match(third.lines.join('\n'), /src\/new\.js/);
  assert.ok(!third.lines.join('\n').includes('src/old.js does not'));
});

test('bad options give clear errors', async () => {
  const dir = await project('Hi.\n');
  const a = capture();
  assert.equal(await main(['check', dir, '--format', 'xml'], a), 1);
  assert.match(a.lines.join('\n'), /--format must be one of/);
  const b = capture();
  assert.equal(await main(['check', dir, '--fail-on', 'sometimes'], b), 1);
  assert.match(b.lines.join('\n'), /--fail-on must be one of/);
});
