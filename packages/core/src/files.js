import { readdir } from 'node:fs/promises';
import path from 'node:path';

export const DOC_EXT = new Set(['.md', '.mdx']);

/** Non document files that are copied to the output when they sit next to the docs. */
export const ASSET_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico',
  '.pdf', '.mp4', '.webm', '.txt', '.woff2',
]);

/** "guides/writing.md" gives "guides/writing". "guides/index.md" gives "guides". "index.md" gives "". */
export function toSlug(rel) {
  const parts = rel.replace(/\.(md|mdx)$/i, '').split('/');
  if (parts.at(-1) === 'index') parts.pop();
  return parts.join('/');
}

/** Pages always get a trailing slash so they can be served from any static host. */
export function toUrl(base, slug) {
  return base + (slug ? `${slug}/` : '');
}

/**
 * List every file under `root` as posix relative paths.
 * Skips dot files, node_modules, files starting with an underscore (except _meta.json),
 * and any directory listed in `skipDirs` (absolute paths, used for the output folder).
 * Symlinks are ignored on purpose so a docs folder cannot pull in files from elsewhere.
 */
export async function walk(root, { skipDirs = [] } = {}) {
  const out = [];

  async function visit(dir, rel) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (skipDirs.includes(abs)) continue;
        await visit(abs, relPath);
      } else if (entry.isFile()) {
        if (entry.name.startsWith('_') && entry.name !== '_meta.json') continue;
        out.push(relPath);
      }
    }
  }

  await visit(root, '');
  return out;
}
