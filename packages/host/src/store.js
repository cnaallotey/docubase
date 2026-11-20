import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Site records in one JSON file. Writes go to a temporary file and are renamed into place,
 * so a crash never leaves half a file, and they are queued so two updates never interleave.
 * Secrets in here are already encrypted by the caller.
 */
export class Store {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, sites: {}, users: {}, sessions: {} };
    this.queue = Promise.resolve();
  }

  async load() {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.sites && typeof parsed.sites === 'object') this.data = parsed;
      // Files from before accounts existed have no users or sessions yet.
      this.data.users ??= {};
      this.data.sessions ??= {};
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`The site database ${this.file} is unreadable: ${error.message}`);
    }
  }

  list() {
    return Object.values(this.data.sites);
  }

  get(slug) {
    return this.data.sites[slug] ?? null;
  }

  user(id) {
    return (id && this.data.users[id]) || null;
  }

  userByEmail(email) {
    return Object.values(this.data.users).find((u) => u.email === email) ?? null;
  }

  userByCustomer(customerId) {
    return (customerId && Object.values(this.data.users).find((u) => u.billing?.customerId === customerId)) || null;
  }

  sitesOf(userId) {
    return this.list().filter((site) => site.owner === userId);
  }

  findByDomain(domain) {
    return this.list().find((site) => site.domains.includes(domain)) ?? null;
  }

  /** Change the data in memory, then write it. The callback may throw to cancel the change. */
  update(change) {
    const run = this.queue.then(async () => {
      const before = JSON.stringify(this.data);
      try {
        const result = change(this.data);
        await this.#write();
        return result;
      } catch (error) {
        this.data = JSON.parse(before);
        throw error;
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async #write() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }
}
