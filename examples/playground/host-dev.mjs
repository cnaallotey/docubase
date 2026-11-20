#!/usr/bin/env node
// Runs the hosting server on your machine so you can try the dashboard.
// Local use only: it listens on 127.0.0.1, keeps a local master key in .host-data, opens sign up,
// and accepts file:// repositories so you can host a folder from this machine.
//
//   node examples/playground/host-dev.mjs
//   open http://app.localhost:8090
//
// Sites are served at http://<name>.localhost:8090. Browsers resolve *.localhost to this machine.
// Settings such as the Paystack test keys can go in examples/playground/.env (copy .env.example).
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost, readSettings } from '../../packages/host/src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Values already in the environment win over the file. The file is git ignored.
try {
  process.loadEnvFile(path.join(here, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const port = Number(process.env.PORT || 8090);
const adminToken = randomBytes(24).toString('base64url');
const dataDir = process.env.DOCUBASE_DATA_DIR || path.join(here, '.host-data');

// Saved secrets are encrypted with the master key, so keep the same key between runs.
async function devMasterKey() {
  const file = path.join(dataDir, 'dev-master-key');
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    const key = randomBytes(32).toString('hex');
    await mkdir(dataDir, { recursive: true });
    await writeFile(file, key, { mode: 0o600 });
    return key;
  }
}

const settings = readSettings({
  ...process.env,
  DOCUBASE_ADMIN_TOKEN: adminToken,
  DOCUBASE_MASTER_KEY: process.env.DOCUBASE_MASTER_KEY || (await devMasterKey()),
  DOCUBASE_BASE_DOMAIN: 'localhost',
  DOCUBASE_DATA_DIR: dataDir,
  DOCUBASE_PUBLIC_URL: `http://localhost:${port}`,
  DOCUBASE_SIGNUP: process.env.DOCUBASE_SIGNUP || 'open',
  PORT: String(port),
  HOST: '127.0.0.1',
});

const host = createHost({ settings, unsafeForTests: { allowFileRepos: true } });
await host.start();
console.log(`Dashboard:  http://app.localhost:${port}`);
console.log(`Sites:      http://<name>.localhost:${port}`);
console.log(`Admin API:  http://localhost:${port}/__host/api/sites  (token for this run: ${adminToken})`);

const stop = async () => {
  await host.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
