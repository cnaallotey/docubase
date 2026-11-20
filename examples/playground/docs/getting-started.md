---
title: Getting started
description: Run the API and the docs side by side.
order: 1
---

You need Node 20 or newer. Run everything from `examples/playground`.

## Run the API

::::tabs
:::tab[With seed data]
```bash
npm run api
```
:::
:::tab[Empty, custom port]
```bash
TASKS_PORT=5000 tasks --token secret
```
:::
::::

The API listens on `127.0.0.1` only. Check it with:

```bash
curl http://127.0.0.1:4010/health
```

## Run the docs

```bash
npm run docs:dev
```

Then open http://127.0.0.1:3001. Edits to any page reload the browser.

## Build and serve

```bash
npm run docs:build
npm run docs:start
```

`docs:build` writes `docs/dist`. `docs:start` serves it and runs Ask AI when the assistant is on.

:::warning[Strict builds fail here on purpose]
The [traps page](testing/drift-traps.md) contains raw HTML and a broken link, so `docubase build docs --strict` exits with an error. That is the point of the page.
:::
