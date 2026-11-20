---
title: Catching docs that quietly went stale
description: docubase check reads your docs and your code together, and fails the pull request when a page describes something that is gone.
date: 2026-11-19
author: The Docubase team
---

Docs rot quietly. Someone renames a flag, deletes a script or moves a file, and the page that mentions it keeps saying the old thing for months. Nobody notices until a new teammate follows it and gets an error.

## Names, not meaning

`docubase check` looks for claims it can verify: paths in inline code, `npm run` commands, flags on your own commands, environment variables, function calls and endpoints from your OpenAPI file. Each one is looked up in the code of the repository. Markdown is left out of that search, so a page cannot prove itself right by repeating its own words.

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
```

## Pages that cover code

Give a page a `covers` list and the check compares git history. If the covered code has a newer commit than the page, the page is reported as stale. It does not claim the page is wrong. It says the code moved and a person should look.

:::warning[It reads names, not intent]
A page can mention a flag that exists and still describe it wrongly. The check narrows what a reviewer has to read. It does not replace them.
:::
