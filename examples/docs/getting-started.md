---
title: Getting started
description: Create a docs folder, start the dev server and build the site.
order: 2
---

You need Node 20 or newer and a folder of Markdown files.

## Create the folder

Make a folder, add an `index.md` and start the dev server:

```bash
mkdir docs
echo "# Hello" > docs/index.md
npx docubase dev docs
```

The dev server runs at `http://127.0.0.1:3000/` and reloads the page when you save a file. It only listens on your own machine unless you pass `--host`.

## Folder layout

Each Markdown file becomes a page. The path decides the address:

| File | Address |
| --- | --- |
| `index.md` | `/` |
| `getting-started.md` | `/getting-started/` |
| `guides/index.md` | `/guides/` |
| `guides/writing.md` | `/guides/writing/` |

Folders become groups in the sidebar. See [Navigation](./guides/navigation.md) to control the order.

## Build for production

```bash
npx docubase build docs
```

The site is written to `docs/dist`. Upload that folder to any static host. See [Deploying](./guides/deploying.md).

:::tip
Run `docubase build --strict` in CI. It fails the build when a link, anchor or image is broken.
:::
