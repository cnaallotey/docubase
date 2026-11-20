import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DocubaseError, loadSite } from '@docubase/core';
import { build } from './build.js';
import { check } from './check.js';
import { dev } from './dev.js';
import { runMcp } from './mcp.js';
import { start } from './start.js';

const HELP = `Docubase: open source docs from a folder of Markdown.

Usage
  docubase build [folder] [--out <folder>] [--strict]
  docubase dev   [folder] [--port <number>] [--host <address>]
  docubase start [folder] [--out <folder>] [--port <number>] [--host <address>]
  docubase mcp   [folder] [--watch]
  docubase check [folder] [--format <text|json|github>] [--fail-on <error|warn|never>] [--external]

Options
  --out <folder>     Where the built site is written or served from (default: dist inside the docs folder)
  --strict           Exit with an error if there are warnings, useful in CI
  --port <number>    Server port (default: 3000, or the PORT variable for start)
  --host <address>   Server address (default: 127.0.0.1, local only)
  --watch            For mcp: reload the docs when files change
  --format <name>    For check: text (default), json, or github (workflow annotations)
  --fail-on <level>  For check: error (default), warn, or never
  --external         For check: also test that links to other sites still work
  --no-history       For check: skip the git history staleness check
  --baseline <file>  For check: ignore findings listed in this file (default: drift.baseline in the config)
  --update-baseline  For check: record today's findings so only new ones fail later
  -v, --version      Print the version
  -h, --help         Show this help

start serves a built site and runs the docs assistant when it is turned on.
mcp runs a local MCP server over stdio so a coding agent can search and read your docs.
check compares the docs with the code in your repository and reports claims that no longer hold.

If you do not name a folder, Docubase uses the current folder when it has a
docubase.config.json, otherwise ./docs when that exists, otherwise the current folder.
`;

async function isDir(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function pickFolder(arg) {
  if (arg) {
    const dir = path.resolve(arg);
    if (!(await isDir(dir))) throw new DocubaseError(`"${arg}" is not a folder.`);
    return dir;
  }
  const cwd = process.cwd();
  if (await isFile(path.join(cwd, 'docubase.config.json'))) return cwd;
  if (await isDir(path.join(cwd, 'docs'))) return path.join(cwd, 'docs');
  return cwd;
}

async function version() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  return JSON.parse(await readFile(file, 'utf8')).version;
}

export async function main(argv, { log = console } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        strict: { type: 'boolean', default: false },
        watch: { type: 'boolean', default: false },
        format: { type: 'string' },
        'fail-on': { type: 'string' },
        external: { type: 'boolean', default: false },
        'no-history': { type: 'boolean', default: false },
        baseline: { type: 'string' },
        'update-baseline': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (error) {
    log.error(`error: ${error.message}\n\n${HELP}`);
    return 1;
  }

  const { values, positionals } = parsed;
  const [command, folderArg] = positionals;

  if (values.version) {
    log.log(await version());
    return 0;
  }
  if (values.help || !command) {
    log.log(HELP);
    return 0;
  }

  try {
    if (command === 'build') {
      const root = await pickFolder(folderArg);
      const started = Date.now();
      const site = await loadSite(root);
      const out = values.out ? path.resolve(values.out) : site.outDir;
      const result = await build(site, { out });
      for (const warning of site.warnings) log.warn(`warning: ${warning}`);
      log.log(`Built ${result.pages} pages in ${Date.now() - started} ms. Output: ${path.relative(process.cwd(), result.out) || '.'}`);
      if (values.strict && site.warnings.length > 0) {
        log.error(`error: ${site.warnings.length} warning${site.warnings.length === 1 ? '' : 's'} found and --strict is on.`);
        return 1;
      }
      return 0;
    }

    if (command === 'dev') {
      const root = await pickFolder(folderArg);
      const port = values.port === undefined ? 3000 : Number(values.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DocubaseError('--port must be a number between 1 and 65535.');
      const server = await dev(root, { port, host: values.host ?? '127.0.0.1', log });
      const stop = async () => {
        await server.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return null; // keep running
    }

    if (command === 'start') {
      const root = await pickFolder(folderArg);
      const raw = values.port ?? process.env.PORT ?? '3000';
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new DocubaseError('The port must be a number between 1 and 65535.');
      const server = await start(root, { out: values.out ? path.resolve(values.out) : undefined, port, host: values.host ?? '127.0.0.1', log });
      const stop = async () => {
        await server.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return null; // keep running
    }

    if (command === 'mcp') {
      const root = await pickFolder(folderArg);
      // stdout carries the protocol, so every message for people goes to stderr.
      const quiet = { log: (...a) => log.error(...a), warn: (...a) => log.error(...a), error: (...a) => log.error(...a) };
      const server = await runMcp(root, { watchFiles: values.watch, log: quiet });
      process.on('SIGINT', () => process.exit(0));
      process.on('SIGTERM', () => process.exit(0));
      server.done.then(() => process.exit(0));
      return null; // keep running until the client closes the pipe
    }

    if (command === 'check') {
      const root = await pickFolder(folderArg);
      return await check(root, {
        format: values.format,
        failOn: values['fail-on'],
        external: values.external,
        history: !values['no-history'],
        baseline: values.baseline,
        updateBaseline: values['update-baseline'],
      }, log);
    }

    log.error(`error: unknown command "${command}"\n\n${HELP}`);
    return 1;
  } catch (error) {
    log.error(`error: ${error.message}`);
    if (!(error instanceof DocubaseError) && process.env.DOCUBASE_DEBUG) log.error(error.stack);
    return 1;
  }
}
