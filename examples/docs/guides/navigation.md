---
title: Navigation
description: Control the order of the sidebar and hide pages.
order: 2
---

By default the sidebar follows your folders. You can adjust it in three ways, from smallest to largest change.

## Order pages with frontmatter

Pages are sorted by `order`, lowest first, then by title. Pages without an order sort after pages that have one.

```yaml
---
title: Installation
order: 1
---
```

## Name and order folders

Add a `_meta.json` file to a folder to set its label and position:

```json
{ "label": "Guides", "order": 2 }
```

Without it, the folder name is used with the first letters capitalised. A folder's `index.md` is always listed first inside its group.

## Write the sidebar yourself

Add a `sidebar` list to `docubase.config.json`. Entries are page paths, objects with a custom label, or groups:

```json
{
  "sidebar": [
    "index",
    "getting-started",
    { "group": "Guides", "items": ["guides/writing", { "slug": "guides/navigation", "label": "Sidebar" }] }
  ]
}
```

A path that does not match a page stops the build with an error that names it.

## Hide a page

Set `hidden: true` in the frontmatter. The page is still built and reachable by its address, but it is left out of the sidebar and the search index.
