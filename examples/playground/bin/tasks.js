#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createApiServer } from '../src/server.js';
import { createStore, seedStore } from '../src/store.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    token: { type: 'string' },
    seed: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`tasks: a tiny tasks API for trying Docubase

Usage
  tasks [--port <number>] [--token <value>] [--seed]

Options
  --port <number>   Port to listen on (default: TASKS_PORT, then 4010)
  --token <value>   Bearer token clients must send (default: TASKS_TOKEN, then dev-token)
  --seed            Start with three example tasks
`);
  process.exit(0);
}

const port = Number(values.port ?? process.env.TASKS_PORT ?? 4010);
const token = values.token ?? process.env.TASKS_TOKEN ?? 'dev-token';

const store = createStore();
if (values.seed) seedStore(store);

const server = createApiServer({ store, token });
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Stop the other process, or pick another port: tasks --port 4011`);
  } else {
    console.error(error.message);
  }
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Tasks API on http://127.0.0.1:${port} (token: ${token === 'dev-token' ? 'dev-token' : 'set'})`);
});
