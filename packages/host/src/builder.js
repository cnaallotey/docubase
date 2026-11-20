import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDocsDir, fetchRepo, RepoError } from './git.js';
import { assertPublicHost } from './netguard.js';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build-worker.js');

function runWorker(job, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [], { execArgv: ['--max-old-space-size=512'], env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], cwd: path.dirname(job.root) });
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new RepoError('The build took too long and was stopped')), timeoutMs);
    child.on('message', (message) => (message.ok ? finish(resolve, message) : finish(reject, new RepoError(message.error))));
    child.on('exit', (code) => finish(reject, new RepoError(`The build stopped unexpectedly (exit code ${code}). The docs may be too large.`)));
    child.on('error', (error) => finish(reject, error));
    child.send(job);
  });
}

/**
 * Fetch a site's repository, build it in an isolated process, and move the result into place.
 * A failed build changes nothing: the previous deploy keeps serving.
 */
export async function buildSite({ site, repoToken, dataDir, settings }) {
  const tmpRoot = path.join(dataDir, 'tmp');
  await mkdir(tmpRoot, { recursive: true });
  const work = await mkdtemp(path.join(tmpRoot, 'build-'));
  try {
    const { root, commit } = await fetchRepo({
      repo: site.repo,
      branch: site.branch,
      dest: work,
      token: repoToken,
      allowFile: settings.allowFileRepos,
      timeoutMs: Math.min(90000, settings.buildTimeoutSeconds * 1000),
      limits: { maxBytes: settings.maxRepoMegabytes * 1e6, maxFiles: settings.maxFiles },
    });

    const docs = path.join(root, checkDocsDir(site.dir));
    let realDocs;
    try {
      realDocs = await realpath(docs);
    } catch {
      throw new RepoError(`The folder "${site.dir || '.'}" does not exist in the repository`);
    }
    const realRoot = await realpath(root);
    if (realDocs !== realRoot && !realDocs.startsWith(realRoot + path.sep)) throw new RepoError('The docs folder is outside the repository');

    const deployId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    const deployDir = path.join(dataDir, 'deploys', site.id, deployId);
    const out = path.join(deployDir, 'site');
    await mkdir(deployDir, { recursive: true });

    let result;
    try {
      result = await runWorker({ root: realDocs, out }, { timeoutMs: settings.buildTimeoutSeconds * 1000 });
      const assistant = result.config.assistant;
      if (assistant.enabled && assistant.baseUrl && !settings.allowPrivateProviders) {
        // A customer config must not point the assistant at servers inside this network.
        const url = new URL(assistant.baseUrl);
        if (url.protocol !== 'https:') throw new RepoError('assistant.baseUrl must use https on a hosted site');
        await assertPublicHost(url.hostname).catch((error) => {
          throw new RepoError(`assistant.baseUrl is not allowed: ${error.message}`);
        });
      }
      await writeFile(path.join(deployDir, 'meta.json'), JSON.stringify({ commit, builtAt: new Date().toISOString(), config: result.config }));
    } catch (error) {
      await rm(deployDir, { recursive: true, force: true });
      throw error;
    }
    return { deployId, commit, pages: result.pages, warnings: result.warnings, config: result.config };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Remove deploys of a site other than the ones named in `keep`. */
export async function pruneDeploys(dataDir, siteId, keep) {
  const dir = path.join(dataDir, 'deploys', siteId);
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) if (!keep.includes(name)) await rm(path.join(dir, name), { recursive: true, force: true });
}
