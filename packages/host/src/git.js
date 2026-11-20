import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { assertPublicHost } from './netguard.js';

export class RepoError extends Error {}

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** Accept public https repository addresses only. No credentials in the URL, no other protocols. */
export function parseRepoUrl(value, { allowFile = false } = {}) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new RepoError('"repo" must be a full address such as https://github.com/acme/docs');
  }
  if (allowFile && url.protocol === 'file:') return url;
  if (url.protocol !== 'https:') throw new RepoError('"repo" must start with https://');
  if (url.username || url.password) throw new RepoError('Do not put credentials in the repo address. Send a read only token as "repoToken" instead.');
  if (url.search || url.hash) throw new RepoError('"repo" cannot have a query or fragment');
  if (url.pathname.length < 3 || !/^\/[A-Za-z0-9._~%+@:/-]+$/.test(url.pathname)) throw new RepoError('"repo" has an unusual path');
  return url;
}

export function checkBranch(value) {
  if (!BRANCH.test(value) || value.includes('..') || value.endsWith('/') || value.endsWith('.lock')) {
    throw new RepoError('"branch" is not a valid branch name');
  }
  return value;
}

/** A folder inside the repository. Empty means the root. */
export function checkDocsDir(value) {
  const dir = String(value ?? '').replace(/^\/+|\/+$/g, '');
  if (dir === '') return '';
  if (dir.length > 200 || dir.split('/').some((part) => part === '..' || part === '.' || part === '' || part.startsWith('.git')) || !/^[A-Za-z0-9._/-]+$/.test(dir)) {
    throw new RepoError('"dir" must be a folder path inside the repository, such as docs');
  }
  return dir;
}

async function measure(dir, { cap, skip = [] }) {
  let bytes = 0;
  let files = 0;
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (skip.includes(entry.name) && current === dir) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else {
        files += 1;
        bytes += (await lstat(full)).size;
      }
      if (bytes > cap.bytes || files > cap.files) return;
    }
  }
  await visit(dir).catch(() => {});
  return { bytes, files };
}

function runGit(args, { cwd, env, timeoutMs, watch }) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { if (stdout.length < 8192) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 8192) stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new RepoError('Fetching the repository took too long')); }, timeoutMs);
    const poll = watch ? setInterval(async () => { if (await watch()) { child.kill('SIGKILL'); reject(new RepoError('The repository is larger than the allowed size')); } }, 1000) : null;
    child.on('error', (error) => { clearTimeout(timer); clearInterval(poll); reject(new RepoError(`git could not run: ${error.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      if (code === 0) resolve(stdout.trim());
      else reject(new RepoError(`git failed: ${stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300) || `exit code ${code}`}`));
    });
  });
}

/**
 * Shallow clone one branch into `dest` and return the commit. Hooks and submodules never run, symbolic links
 * are not created, the size is checked while it downloads, and a token is passed in the environment so it
 * never appears in the process list or in the URL.
 */
export async function fetchRepo({ repo, branch, dest, token, allowFile = false, timeoutMs = 90000, limits }) {
  const url = parseRepoUrl(repo, { allowFile });
  checkBranch(branch);
  if (url.protocol === 'https:') {
    try {
      await assertPublicHost(url.hostname);
    } catch (error) {
      throw new RepoError(`The repository host is not allowed: ${error.message}`);
    }
  }

  await mkdir(dest, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: dest,
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ALLOW_PROTOCOL: allowFile ? 'https:file' : 'https',
    GIT_ASKPASS: 'true',
  };
  if (token) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }

  const target = path.join(dest, 'repo');
  const cap = { bytes: limits.maxBytes * 4, files: limits.maxFiles * 4 }; // the .git folder is larger than the docs
  const args = [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.symlinks=false', '-c', 'core.fsmonitor=false', '-c', 'protocol.version=2', '-c', 'http.followRedirects=false',
    'clone', '--depth', '1', '--single-branch', '--branch', branch, '--no-tags', '--no-recurse-submodules', '--', url.href, target,
  ];
  try {
    await runGit(args, {
      cwd: dest,
      env,
      timeoutMs,
      watch: async () => {
        const size = await measure(target, { cap }).catch(() => ({ bytes: 0, files: 0 }));
        return size.bytes > cap.bytes;
      },
    });
  } catch (error) {
    if (token && error.message) error.message = error.message.split(token).join('[token]');
    throw error;
  }

  const commit = await runGit(['rev-parse', 'HEAD'], { cwd: target, env, timeoutMs: 10000 });
  await rm(path.join(target, '.git'), { recursive: true, force: true });

  const size = await measure(target, { cap: { bytes: limits.maxBytes, files: limits.maxFiles } });
  if (size.bytes > limits.maxBytes) throw new RepoError(`The repository is ${Math.ceil(size.bytes / 1e6)} MB, above the ${Math.floor(limits.maxBytes / 1e6)} MB limit`);
  if (size.files > limits.maxFiles) throw new RepoError(`The repository has more than ${limits.maxFiles} files`);
  return { root: target, commit };
}
