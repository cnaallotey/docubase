import { createServer } from 'node:http';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

// The docs playground calls this API from another origin, so allow it.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '600',
};

function send(res, status, body) {
  res.writeHead(status, { ...CORS_HEADERS, ...(body === undefined ? {} : JSON_HEADERS) });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Body is not valid JSON'), { status: 400 });
  }
}

/** Build the HTTP server. `token` is the bearer token every request must send. */
export function createApiServer({ store, token }) {
  return createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204);

    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') return send(res, 200, { ok: true });

    if (req.headers.authorization !== `Bearer ${token}`) {
      return send(res, 401, { error: 'Send Authorization: Bearer <token>' });
    }

    try {
      if (url.pathname === '/tasks') {
        if (req.method === 'GET') {
          const done = url.searchParams.get('done');
          return send(res, 200, store.listTasks({ done: done === null ? undefined : done === 'true' }));
        }
        if (req.method === 'POST') return send(res, 201, store.addTask(await readJson(req)));
      }

      const match = url.pathname.match(/^\/tasks\/([^/]+)$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        if (req.method === 'GET') {
          const task = store.getTask(id);
          return task ? send(res, 200, task) : send(res, 404, { error: 'No task with that id' });
        }
        if (req.method === 'PATCH') {
          const task = store.updateTask(id, await readJson(req));
          return task ? send(res, 200, task) : send(res, 404, { error: 'No task with that id' });
        }
        if (req.method === 'DELETE') {
          return store.removeTask(id) ? send(res, 204) : send(res, 404, { error: 'No task with that id' });
        }
      }

      return send(res, 404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof TypeError) return send(res, 400, { error: error.message });
      return send(res, error.status ?? 500, { error: error.status ? error.message : 'Server error' });
    }
  });
}
