---
title: Docs that read like a letter
description: Why we built Docubase, an open source docs generator with search, agents and hosting built in, and no account to sign up for.
date: 2026-11-04
author: The Docubase team
---

Most documentation tools ask for something before they give anything back. An account, a monthly bill that grows with traffic, or a framework you did not choose. We wanted the opposite: point a command at a folder of Markdown and get a site you would be proud to send to someone.

## One folder, one command

```bash
npx docubase dev docs
```

That is the whole setup. Folders become the sidebar, frontmatter sets the order, and the search index is built at the same time as the pages. Nothing is uploaded and nothing phones home. The output is plain HTML, CSS and a little JavaScript that any static host can serve.

## Built for readers and for agents

People read docs, and more and more, so do coding agents. Every page is also published as Markdown, with `llms.txt` and `llms-full.txt` next to it. A local MCP server lets an editor search your docs without a network, and the hosted one does the same over HTTP.

:::tip[Try it on your own docs]
Run `npx docubase check docs` to find pages that mention files, flags or scripts that no longer exist.
:::

## Yours to host

Docubase is MIT licensed. Run it on a laptop, in a Docker container, or on the hosting server that builds sites from git and rebuilds on every push. The managed tier is the same code you can run yourself.
