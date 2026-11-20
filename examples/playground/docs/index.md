---
title: Tasks Demo
description: A small, real API with docs, built to try every Docubase feature by hand.
order: 0
---

This site is a test bed. The API it documents is real and runs on your machine, so the request playground, the drift check and the MCP server all have something true to compare against.

## Start here

1. Start the API with `npm run api` in `examples/playground`.
2. Start these docs with `npm run docs:dev` in a second terminal.
3. Open the [Tasks API reference](api/) and send a request with **Try it**.

:::tip
The default token is `dev-token`. Paste it into the credentials box of the playground.
:::

## What to try

- [x] Sidebar from folders, `order` and `_meta.json`
- [x] Search with `/` or `Ctrl K`
- [ ] Callouts and tabs on the [Markdown features](guides/markdown.md) page
- [ ] The [Try it](api/) box against the local API
- [ ] `npm run docs:check` for drift detection
- [ ] `npm run docs:mcp` for the local MCP server, or `npm run docs:build` then `npm run docs:start` for the hosted one at `/__docubase/mcp`
- [ ] Ask AI streaming its answer, after turning on the assistant as described in the [command reference](reference/cli.md)
- [ ] Moving between pages without a reload in the Nuxt example
- [ ] The hosting dashboard with `npm run host`
- [ ] The [traps page](testing/drift-traps.md), which breaks things on purpose
