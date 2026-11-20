---
title: Docubase
description: Turn a folder of Markdown into a fast docs site with search. Open source, MIT licensed, no account needed.
order: 1
---

Docubase reads a folder of Markdown files and builds a static docs site. You get a sidebar, a table of contents, dark mode and full text search without writing any configuration.

## What you get

* **Plain Markdown.** Pages are `.md` files with a little frontmatter. Nothing is stored anywhere else, so you can move your content to another tool whenever you want.
* **Search that works offline.** The search index is built when you build the site and runs in the browser. There is no search service to pay for.
* **One command.** Run `npx docubase dev` in a folder with Markdown files to start writing.
* **Your own hosting.** The output is plain HTML, CSS and a little JavaScript. Put it on any static host.

## Try it

::::tabs
:::tab[npm]
```bash
npx docubase dev
```
:::
:::tab[pnpm]
```bash
pnpm dlx docubase dev
```
:::
::::

Then read [Getting started](./getting-started.md) for the folder layout, or jump to [Writing pages](./guides/writing.md).

:::note[Early release]
This is the first phase of Docubase. The generator, theme and search work today. The AI assistant, OpenAPI reference and hosting options are planned, see [Roadmap](./roadmap.md).
:::
