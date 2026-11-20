import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import YAML from 'yaml';
import { loadConfig, normalizeConfig } from '../config.js';
import { DOC_EXT, walk } from '../files.js';
import { normalizeFrontmatter } from '../markdown.js';
import { loadSpec } from '../openapi.js';
import { DocubaseError } from '../util.js';
import { codeIndexFor } from './run-index.js';
import { checkExternal } from './external.js';
import { extractClaims } from './extract.js';
import { createGit, historyStatus, lastCommit } from './git.js';
import { RULES } from './rules.js';

export { RULES } from './rules.js';
export { applyBaseline, findingKey, readBaseline, writeBaseline } from './baseline.js';

const METHODS = '(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)';
const ENDPOINT = new RegExp(`^${METHODS}\\s+(/\\S*)$`);
const ENV_NAME = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;
const SYMBOL = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*\(.*\)$/;
const FLAG = /^--[a-zA-Z][\w-]*/;
const SCRIPT = /^(?:npm|pnpm|yarn|bun)\s+(?:run|run-script)\s+([\w:.-]+)/;
const CONFIG_EXT = /\.(json|jsonc|yaml|yml|toml|ini|env|lock|md|mdx|sh|css|html|xml)$/i;
const ANY_EXT = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const RUNNERS = new Set(['npx', 'bunx']);
const SHELL_BREAK = new Set(['|', '||', '&&', ';', '>', '>>', '<', '2>&1']);

/**
 * The repository root is the nearest folder with a .git entry. Without git
 * (a plain download, some CI caches) fall back to the nearest package.json
 * that declares workspaces, then the nearest package.json, then the docs folder.
 */
async function findRepoRoot(start) {
  const exists = async (p) => stat(p).then(() => true, () => false);
  const ancestors = [];
  for (let dir = start; ; dir = path.dirname(dir)) {
    ancestors.push(dir);
    if (path.dirname(dir) === dir) break;
  }
  for (const dir of ancestors) if (await exists(path.join(dir, '.git'))) return dir;
  let nearest = null;
  for (const dir of ancestors) {
    let pkg;
    try {
      pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (pkg.workspaces) return dir;
    nearest ??= dir;
  }
  return nearest;
}

/** "/users/{id}", "/users/:id" and "/users/<id>" all become "/users/{}". */
function shape(p) {
  return p
    .replace(/\/+$/, '')
    .split('/')
    .map((seg) => (/^(\{.*\}|:.+|<.+>)$/.test(seg) ? '{}' : seg))
    .join('/') || '/';
}

function looksLikePath(v) {
  if (/\s/.test(v) || /[<>{}*$|?:@~\\^]/.test(v) || v.startsWith('/') || v.includes('://') || v.startsWith('-')) return false;
  if (v.includes('/')) return v.endsWith('/') || ANY_EXT.test(v);
  return CONFIG_EXT.test(v) && !v.startsWith('.');
}

function jsonProblem(text) {
  if (/\.\.\.|…/.test(text) || /^\s*\/\//m.test(text)) return null; // placeholders and comments are normal in examples
  try {
    JSON.parse(text);
    return null;
  } catch (error) {
    return error.message.split('\n')[0];
  }
}

function yamlProblem(text) {
  if (/\.\.\.|…/.test(text.replace(/^\.\.\.$/gm, ''))) return null;
  try {
    const docs = YAML.parseAllDocuments(text);
    const bad = docs.flatMap((d) => d.errors)[0];
    return bad ? bad.message.split('\n')[0] : null;
  } catch (error) {
    return error.message.split('\n')[0];
  }
}

/**
 * Compare what the docs say about the code with the code.
 * Returns findings, each with a rule, a level, a file and line, and a message,
 * plus notes about checks that could not run.
 */
export async function runDrift(docsDir, { configOverrides = {}, history = true, external = false, fetchImpl, git, lookup } = {}) {
  const root = path.resolve(docsDir);
  const loaded = await loadConfig(root);
  const config = Object.keys(configOverrides).length ? normalizeConfig({ ...loaded, ...configOverrides }) : loaded;
  const drift = config.drift;
  const outDir = path.resolve(root, config.outDir);

  const repoRoot = drift.repo ? path.resolve(root, drift.repo) : ((await findRepoRoot(root)) ?? root);
  const docsRel = path.relative(repoRoot, root).split(path.sep).join('/');
  if (docsRel.startsWith('..') || path.isAbsolute(docsRel)) {
    throw new DocubaseError('The docs folder must be inside the repository. Check "drift.repo" in docubase.config.json.');
  }

  const baselinePath = drift.baseline ? path.resolve(root, drift.baseline) : null;
  if (baselinePath) {
    const inside = path.relative(repoRoot, baselinePath);
    if (inside.startsWith('..') || path.isAbsolute(inside)) throw new DocubaseError('"drift.baseline" must be a file inside the repository.');
  }

  const level = (rule) => drift.rules[rule] ?? RULES[rule];
  const findings = [];
  const notes = [];
  const exactIgnored = new Set(drift.ignoreTokens.filter((t) => !t.includes('*')));
  const globIgnored = drift.ignoreTokens.filter((t) => t.includes('*'));
  const globMatch = globIgnored.length ? picomatch(globIgnored, { dot: true }) : () => false;
  const isIgnored = (token) => exactIgnored.has(token) || globMatch(token);
  const add = (rule, file, line, token, message) => {
    if (level(rule) === 'off' || isIgnored(token)) return;
    findings.push({ rule, level: level(rule), file, line, token, message });
  };

  const index = await codeIndexFor(repoRoot, [outDir]);
  const files = (await walk(root, { skipDirs: [outDir] })).filter((f) => DOC_EXT.has(path.posix.extname(f).toLowerCase()) && !f.startsWith('public/'));
  const skipDoc = drift.ignore.length ? picomatch(drift.ignore, { dot: true }) : () => false;
  const docs = files.filter((f) => !skipDoc(f));

  let endpoints = null;
  if (config.openapi && level('unknown-endpoint') !== 'off') {
    const spec = await loadSpec(root, config.openapi.spec);
    endpoints = new Set();
    for (const [route, item] of Object.entries(spec.paths)) {
      for (const method of Object.keys(item ?? {})) {
        if (/^(get|put|post|delete|options|head|patch)$/i.test(method)) endpoints.add(`${method.toUpperCase()} ${shape(route)}`);
      }
    }
  }

  const resolveExists = (value, docRel) => {
    const clean = value.replace(/^\.\//, '').replace(/\/+$/, '');
    const bases = ['', docsRel, path.posix.join(docsRel, path.posix.dirname(docRel))];
    return bases.some((b) => {
      const candidate = path.posix.normalize(path.posix.join(b, clean));
      return !candidate.startsWith('..') && (index.files.has(candidate) || index.dirs.has(candidate));
    });
  };

  const checkFlag = (flag, file, line) => {
    const name = flag.match(FLAG)?.[0];
    if (name && !index.flags.has(name) && !index.words.has(name.slice(2))) {
      add('missing-flag', file, line, name, `The flag ${name} does not appear anywhere in the code.`);
    }
  };
  const checkEnv = (name, file, line) => {
    if (!index.identifiers.has(name)) add('missing-env', file, line, name, `The environment variable ${name} is not read anywhere in the code.`);
  };
  const checkScript = (name, file, line) => {
    if (!index.scripts.has(name)) add('missing-script', file, line, `script:${name}`, `No package.json has a script named "${name}".`);
  };

  const checkShell = (value, file, line) => {
    const tokens = [];
    for (const t of value.split(/\s+/)) {
      if (SHELL_BREAK.has(t)) break;
      tokens.push(t);
    }
    let rest = tokens;
    while (rest.length && /^(export|sudo)$/.test(rest[0])) rest = rest.slice(1);
    while (rest.length && /^[A-Z][A-Z0-9_]*=/.test(rest[0])) {
      checkEnv(rest[0].split('=')[0], file, line);
      rest = rest.slice(1);
    }
    if (/^(npm|pnpm|yarn|bun)$/.test(rest[0] ?? '') && /^(run|run-script)$/.test(rest[1] ?? '') && rest[2]) {
      checkScript(rest[2], file, line);
      return;
    }
    if (RUNNERS.has(rest[0]) || (/^(pnpm|npm)$/.test(rest[0] ?? '') && /^(dlx|exec)$/.test(rest[1] ?? ''))) {
      rest = rest.slice(RUNNERS.has(rest[0]) ? 1 : 2);
      while (rest.length && rest[0].startsWith('-')) rest = rest.slice(1);
    }
    if (rest.length && index.bins.has(rest[0].replace(/@.*$/, ''))) {
      for (const t of rest.slice(1)) if (FLAG.test(t)) checkFlag(t, file, line);
    }
  };

  const externalLinks = [];
  const staleJobs = [];
  let claimCount = 0;

  for (const source of docs) {
    const raw = await readFile(path.join(root, source), 'utf8');
    let extracted;
    try {
      extracted = extractClaims(raw);
    } catch (error) {
      throw new DocubaseError(`${source}: invalid frontmatter (${error.reason || error.message})`);
    }
    const fm = normalizeFrontmatter(extracted.data, source);
    if (fm.driftIgnore) continue;
    const file = path.posix.join(docsRel, source);
    if (fm.covers) staleJobs.push({ source, file, covers: fm.covers });

    for (const claim of extracted.claims) {
      claimCount++;
      const { kind, value, line } = claim;
      if (kind === 'json') {
        const problem = jsonProblem(value);
        if (problem) add('invalid-json', file, line, `json:${line}`, `This JSON example does not parse: ${problem}. Add drift-ignore after the language to skip it.`);
      } else if (kind === 'yaml') {
        const problem = yamlProblem(value);
        if (problem) add('invalid-yaml', file, line, `yaml:${line}`, `This YAML example does not parse: ${problem}. Add drift-ignore after the language to skip it.`);
      } else if (kind === 'external') {
        externalLinks.push({ url: value, file, line });
      } else if (kind === 'link') {
        const ext = path.posix.extname(value);
        const target = path.posix.normalize(path.posix.join(docsRel, path.posix.dirname(source), decodeURI(value)));
        const inDocs = docsRel === '' || target === docsRel || target.startsWith(`${docsRel}/`);
        if (ext && !(DOC_EXT.has(ext.toLowerCase()) && inDocs) && !target.startsWith('..') && !index.files.has(target)) {
          add('missing-file', file, line, value, `The link target ${value} does not exist in the repository.`);
        }
      } else if (kind === 'shell') {
        checkShell(value, file, line);
      } else if (kind === 'inline') {
        let m;
        const first = value.split(/\s+/)[0].replace(/@.*$/, '');
        if (/\s/.test(value) && (index.bins.has(first) || (RUNNERS.has(first) && !SCRIPT.test(value)))) {
          checkShell(value, file, line);
        } else if ((m = value.match(ENDPOINT))) {
          if (endpoints && !endpoints.has(`${m[1]} ${shape(m[2].split('?')[0])}`)) {
            add('unknown-endpoint', file, line, value, `${m[1]} ${m[2]} is not in the OpenAPI file.`);
          }
        } else if (SCRIPT.test(value)) {
          checkScript(value.match(SCRIPT)[1], file, line);
        } else if (FLAG.test(value) && /^--[\w-]+(\s|=|$)/.test(value)) {
          checkFlag(value, file, line);
        } else if (ENV_NAME.test(value)) {
          checkEnv(value, file, line);
        } else if (SYMBOL.test(value)) {
          const name = value.slice(0, value.indexOf('(')).split('.').pop();
          if (!index.identifiers.has(name)) add('missing-symbol', file, line, name, `${name}() is not defined or used anywhere in the code.`);
        } else if (looksLikePath(value) && !resolveExists(value, source)) {
          add('missing-file', file, line, value, `${value} does not exist in the repository.`);
        }
      }
    }
  }

  // Pages that declare which code they cover.
  for (const job of staleJobs) {
    const match = picomatch(job.covers, { dot: true });
    const matched = [...index.files].filter((f) => match(f));
    if (matched.length === 0) {
      add('covers-no-match', job.file, 1, `covers:${job.covers.join(',')}`, `None of the files in "covers" exist: ${job.covers.join(', ')}.`);
    }
    job.matched = matched;
  }

  if (staleJobs.length && level('stale') !== 'off') {
    if (!history) notes.push('History checks were skipped (--no-history).');
    else {
      const run = git ?? createGit(repoRoot);
      const status = await historyStatus(run);
      if (status !== 'ok') notes.push(`Staleness checks were skipped: ${status}.`);
      else {
        for (const job of staleJobs) {
          if (!job.matched.length) continue;
          const docCommit = await lastCommit(run, [job.file]);
          const codeCommit = await lastCommit(run, job.matched);
          if (docCommit && codeCommit && codeCommit.time > docCommit.time) {
            const day = (c) => new Date(c.time * 1000).toISOString().slice(0, 10);
            add('stale', job.file, 1, `covers:${job.covers.join(',')}`,
              `Code this page covers changed on ${day(codeCommit)} (${codeCommit.hash} "${codeCommit.subject}") after the page was last edited on ${day(docCommit)}. Review the page, then edit it.`);
          }
        }
      }
    }
  }

  if (external && level('external-link') !== 'off' && externalLinks.length) {
    const problems = await checkExternal(externalLinks.map((l) => l.url), { fetchImpl, timeoutMs: drift.external.timeoutMs, ignore: drift.external.ignore, lookup });
    for (const link of externalLinks) {
      const problem = problems.get(link.url);
      if (problem) add('external-link', link.file, link.line, link.url, `${link.url} ${problem}.`);
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
  return { repoRoot, docsRel, findings, notes, docs: docs.length, claims: claimCount, baselinePath };
}
