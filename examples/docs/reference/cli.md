---
title: Command line
description: The build, dev, start, mcp and check commands and their options.
order: 3
---

## docubase build

```bash
docubase build [folder] [--out <folder>] [--strict]
```

Builds the site. Prints warnings for broken links, missing images, unknown directives and removed HTML.

| Option | What it does |
| --- | --- |
| `--out <folder>` | Write the site somewhere other than `dist` |
| `--strict` | Exit with an error when there are warnings |

## docubase dev

```bash
docubase dev [folder] [--port <number>] [--host <address>]
```

Starts a local server that rebuilds and reloads the browser when a file changes. Build errors appear on the page and in the terminal. The dev server always serves from `/`, even when your config sets a base path.

| Option | What it does |
| --- | --- |
| `--port <number>` | Port to listen on. Default 3000 |
| `--host <address>` | Address to listen on. Default `127.0.0.1`, which only your machine can reach |

## docubase start

```bash
docubase start [folder] [--out <folder>] [--port <number>] [--host <address>]
```

Serves a site you already built, under its `base` path. When the assistant is on, it also answers questions at `/__docubase/ask`, streaming when asked to. When `mcp` is on, it answers the Model Context Protocol at `/__docubase/mcp`. Run `docubase build` first. It refuses to start if the assistant is enabled and no API key is set in the environment.

| Option | What it does |
| --- | --- |
| `--out <folder>` | Serve a build from somewhere other than `dist` |
| `--port <number>` | Port to listen on. Default 3000, or the `PORT` variable |
| `--host <address>` | Address to listen on. Default `127.0.0.1`. Use `0.0.0.0` to accept outside connections |

## docubase mcp

```bash
docubase mcp [folder] [--watch]
```

Runs a local MCP server over stdio. Messages for people go to stderr, because stdout carries the protocol. `--watch` reloads the docs when files change. See [AI and agents](../guides/ai-and-agents.md).

## docubase check

```bash
docubase check [folder] [--format <text|json|github>] [--fail-on <error|warn|never>] [--external]
```

Compares the docs with the code in your repository and reports files, flags, scripts, environment variables, endpoints and examples that no longer match. Exits with 1 when it finds errors. See [Docs drift detection](../guides/drift-detection.md).

| Option | What it does |
| --- | --- |
| `--format <name>` | `text` (default), `json`, or `github` for workflow annotations |
| `--fail-on <level>` | `error` (default), `warn`, or `never` |
| `--external` | Also test that links to other sites still work |
| `--no-history` | Skip the git history check for stale pages |
| `--baseline <file>` | Ignore findings listed in this file |
| `--update-baseline` | Write today's findings to the baseline file and exit |

## Choosing the folder

If you do not name a folder, Docubase uses the current folder when it contains `docubase.config.json`, then `./docs` when that exists, then the current folder.
