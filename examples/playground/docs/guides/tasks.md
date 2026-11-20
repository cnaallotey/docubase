---
title: Working with tasks
description: How the task store behaves.
order: 2
covers:
  - src/store.js
---

Tasks live in memory, in the store built by `createStore()` in `src/store.js`. Restarting the API clears them. Pass `--seed` to start with three examples, which come from `seedStore()`.

## Fields

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | A UUID set by the server |
| `title` | string | Required, trimmed, never empty |
| `done` | boolean | Defaults to `false` |
| `createdAt` | string | ISO 8601 time set by the server |

## Endpoints

- `GET /tasks` lists tasks. Add `?done=true` or `?done=false` to filter.
- `POST /tasks` creates one.
- `GET /tasks/{id}` reads one.
- `PATCH /tasks/{id}` changes the title, `done`, or both.
- `DELETE /tasks/{id}` removes one.

:::note
This page sets `covers` to the store file. Commit a change to `src/store.js` after the last commit of this page and `docubase check` reports the page as stale.
:::
