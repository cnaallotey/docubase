import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serveStatic } from '../src/static.js';

function fakeRes() {
  const res = { status: null, headers: {}, body: null };
  res.writeHead = (status, headers = {}) => { res.status = status; res.headers = headers; return res; };
  res.end = (body) => { res.body = body; return res; };
  return res;
}

test('SVG files are served with a policy that blocks scripts when opened directly', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'docubase-static-'));
  await writeFile(path.join(dir, 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const res = fakeRes();
  await serveStatic(res, dir, '/x.svg');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-security-policy'], /default-src 'none'/);
  assert.match(res.headers['content-security-policy'], /sandbox/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('paths that climb out of the folder are refused', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'docubase-static-'));
  for (const bad of ['/../etc/passwd', '/a/../../etc/passwd', '/%00']) {
    const res = fakeRes();
    await serveStatic(res, dir, bad.includes('%00') ? '/\u0000' : bad);
    assert.ok([403, 404].includes(res.status), `${bad} gave ${res.status}`);
  }
});
