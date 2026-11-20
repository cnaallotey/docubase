---
title: Deploying
description: Put the built site on a static host.
order: 4
---

`docubase build` writes plain files, so any static host works.

## Build

```bash
npx docubase build docs --out public_html
```

The output folder is emptied on every build. To protect your work, Docubase refuses to write into a folder that already has files in it unless an earlier build created it.

## Hosting under a sub path

If the site lives at `https://example.com/docs/`, set the base path in `docubase.config.json`:

```json
{ "base": "/docs/" }
```

All links, scripts and search requests then include the prefix.

## Hosts

Upload the output folder to a host such as Netlify, Cloudflare Pages, GitHub Pages or any web server. Point the host's "not found" page at `404.html`.

:::tip
Pages are written as `folder/index.html` and linked with a trailing slash, so no rewrite rules are needed.
:::

## Running the assistant

Static hosts cannot run the Ask AI endpoint. Either run `docubase start` on a Node server, which serves the site and the assistant together, or host the files statically and run `docubase start` elsewhere with `assistant.endpoint` pointing at it. See [AI and agents](./ai-and-agents.md).

To run it in a container, see [Self hosting with Docker](./self-hosting.md). To serve many sites from git, see [Managed hosting](./managed-hosting.md).
