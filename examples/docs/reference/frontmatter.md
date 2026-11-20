---
title: Frontmatter
description: Fields you can set at the top of a page.
order: 2
---

Frontmatter is YAML between two `---` lines at the top of a file.

| Field | Type | What it does |
| --- | --- | --- |
| `title` | string | Page title. Defaults to the first `# Heading`, then the file name |
| `description` | string | Shown under the title, in search results and in the page metadata |
| `order` | number | Position in the sidebar, lowest first |
| `hidden` | true or false | Leave the page out of the sidebar and search |
| `date` | date | Makes the page a post when `blog` is on, written as 2026-11-20 |
| `author` | string | Shown under the title of a post |

A field with the wrong type, such as `order: first`, stops the build and names the file.

:::danger
JavaScript frontmatter is refused. Frontmatter is data only, so a docs file can never run code while the site builds.
:::
