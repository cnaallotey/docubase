import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Run git in a repository and return stdout, or null when git fails or is missing. */
export function createGit(repoRoot) {
  return async function git(args) {
    try {
      const { stdout } = await run('git', ['--no-pager', '-c', 'core.quotepath=off', '-C', repoRoot, ...args], {
        timeout: 20000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      return stdout;
    } catch {
      return null;
    }
  };
}

function parseLine(out) {
  const line = (out ?? '').trim().split('\n')[0];
  if (!line) return null;
  const [ts, hash, ...subject] = line.split('\t');
  const time = Number(ts);
  return Number.isFinite(time) ? { time, hash, subject: subject.join('\t') } : null;
}

/** Newest commit touching any of the given files, in chunks so very large matches still work. */
export async function lastCommit(git, files) {
  let best = null;
  for (let i = 0; i < files.length; i += 200) {
    const specs = files.slice(i, i + 200).map((f) => `:(literal)${f}`);
    const found = parseLine(await git(['log', '-1', '--format=%ct%x09%h%x09%s', '--', ...specs]));
    if (found && (!best || found.time > best.time)) best = found;
  }
  return best;
}

/** "ok", or a short reason history checks cannot run. */
export async function historyStatus(git) {
  if ((await git(['rev-parse', '--is-inside-work-tree']))?.trim() !== 'true') return 'this folder is not inside a git repository';
  if ((await git(['rev-parse', '--is-shallow-repository']))?.trim() === 'true') {
    return 'the clone is shallow, so file history is incomplete (use fetch-depth: 0 in your checkout step)';
  }
  return 'ok';
}
