import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.nuxt', '.output', '.next', '.cache', '.turbo', '.data', 'vendor', 'target', '__pycache__']);
const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'composer.lock', 'Cargo.lock', 'poetry.lock']);
const NOT_CODE_EXT = new Set([
  '.md', '.mdx', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico', '.pdf', '.mp4', '.webm',
  '.woff', '.woff2', '.ttf', '.otf', '.zip', '.gz', '.tgz', '.map', '.lock',
]);
const MAX_FILE_BYTES = 1024 * 1024;

const IDENT = /[A-Za-z_$][\w$]*/g;
const WORD = /[A-Za-z][\w-]*/g;
const FLAG = /(?<![\w-])--[a-zA-Z][\w-]*/g;

/**
 * Read the repository once and keep what the rules need:
 * every file path, every folder, the identifiers and flags that appear in code,
 * and the scripts and commands declared in package.json files.
 * Markdown is left out of the token index on purpose, otherwise a doc would
 * prove itself right by mentioning the thing it is checked against.
 */
export async function indexRepo(repoRoot, { skip = [] } = {}) {
  const files = new Set();
  const dirs = new Set(['']);
  const skipAbs = skip.map((p) => path.resolve(p));
  const identifiers = new Set();
  const flags = new Set();
  const words = new Set();
  const scripts = new Set();
  const bins = new Set();
  const textFiles = [];

  async function visit(abs, rel) {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || skipAbs.includes(childAbs)) continue;
        dirs.add(childRel);
        await visit(childAbs, childRel);
      } else if (entry.isFile()) {
        files.add(childRel);
        if (SKIP_FILES.has(entry.name)) continue;
        if (NOT_CODE_EXT.has(path.extname(entry.name).toLowerCase())) continue;
        textFiles.push({ abs: childAbs, rel: childRel });
      }
    }
  }
  await visit(path.resolve(repoRoot), '');

  for (const file of textFiles) {
    let info;
    try {
      info = await stat(file.abs);
    } catch {
      continue;
    }
    if (info.size > MAX_FILE_BYTES) continue;
    let text;
    try {
      text = await readFile(file.abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue; // binary
    for (const m of text.matchAll(IDENT)) identifiers.add(m[0]);
    for (const m of text.matchAll(FLAG)) flags.add(m[0]);
    for (const m of text.matchAll(WORD)) words.add(m[0]);
    if (path.posix.basename(file.rel) === 'package.json') {
      try {
        const pkg = JSON.parse(text);
        for (const name of Object.keys(pkg.scripts ?? {})) scripts.add(name);
        if (typeof pkg.bin === 'string' && pkg.name) bins.add(pkg.name.split('/').pop());
        else if (pkg.bin && typeof pkg.bin === 'object') for (const name of Object.keys(pkg.bin)) bins.add(name);
      } catch {
        // A broken package.json is the author's problem, not a reason to stop the check.
      }
    }
  }

  return { root: path.resolve(repoRoot), files, dirs, identifiers, flags, words, scripts, bins };
}
