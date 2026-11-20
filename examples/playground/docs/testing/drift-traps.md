---
title: Traps
description: Things that are wrong on purpose, to see warnings and drift findings fire.
order: 1
---

Everything on this page is broken deliberately. The drift config ignores this file so `npm run docs:check` stays clean. To see the findings, remove `testing/drift-traps.md` from `drift.ignore` in the config and run the check again.

## Build warnings

A broken link: [this page does not exist](../nope.md).

A missing image: ![missing](../img/missing.png)

Raw HTML that gets removed: <script>alert('removed')</script> <b>bold via HTML</b>

## Drift findings

- A missing file: `src/does-not-exist.js`
- A missing script: `npm run deploy`
- A missing flag on our own command: `tasks --verbose`
- A missing environment variable: `TASKS_DATABASE_URL`
- A missing function: `archiveTask()`
- An unknown endpoint: `GET /projects/{id}`

Invalid JSON:

```json
{ "title": "missing closing brace"
```

Invalid YAML:

```yaml
title: [unclosed
```
