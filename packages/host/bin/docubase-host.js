#!/usr/bin/env node
import { createHost, readSettings, SettingsError } from '../src/index.js';

let settings;
try {
  settings = readSettings(process.env);
} catch (error) {
  if (error instanceof SettingsError) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

const host = createHost({ settings });
const { url } = await host.start();
console.log(`Docubase host listening on ${url}`);
console.log(`  Sites are served at <name>.${settings.baseDomain}`);
console.log(`  Data directory: ${settings.dataDir}`);
console.log('  Admin API: /__host/api/sites (bearer token required)');

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await host.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
