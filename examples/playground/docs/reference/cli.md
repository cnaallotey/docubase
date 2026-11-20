---
title: tasks command
description: Options for the tasks command.
order: 1
---

```bash
tasks --port 4010 --token dev-token --seed
```

| Option | Default | What it does |
| --- | --- | --- |
| `--port` | `TASKS_PORT`, then `4010` | Port to listen on |
| `--token` | `TASKS_TOKEN`, then `dev-token` | Bearer token every request must send |
| `--seed` | off | Start with three example tasks |
| `--help` | | Print the options |

## Environment variables

| Name | What it does |
| --- | --- |
| `TASKS_PORT` | Port, when `--port` is not given |
| `TASKS_TOKEN` | Token, when `--token` is not given |

## Scripts

| Script | What it runs |
| --- | --- |
| `npm run api` | The API with seed data |
| `npm run docs:dev` | Docs with live reload |
| `npm run docs:build` | A static build in `docs/dist` |
| `npm run docs:start` | Serves the build, plus Ask AI when it is on |
| `npm run docs:check` | Drift detection |
| `npm run docs:mcp` | The MCP server over stdio |
| `npm run host` | The hosting server and dashboard at http://app.localhost:8090 |

## Turn on Ask AI

Set `assistant.enabled` to `true` in `docs/docubase.config.json`, export `ANTHROPIC_API_KEY`, then run `npm run docs:build` and `npm run docs:start`. Answers stream into the dialog as they are written.

## Hosted MCP endpoint

The config already turns on `mcp`, so `npm run docs:start` also answers MCP at http://127.0.0.1:3000/__docubase/mcp. Point an MCP client at that address with the `http` transport.
