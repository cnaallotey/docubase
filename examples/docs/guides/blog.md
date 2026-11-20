---
title: Blog
description: Turn a folder into a blog with dated posts, a post list and an Atom feed.
order: 4
---

Docubase can publish a blog from the same Markdown you use for docs. Turn it on in `docubase.config.json`:

```json
{
  "title": "Acme Journal",
  "siteUrl": "https://acme.com",
  "blog": true
}
```

## Write a post

Any page with a `date` in its frontmatter is a post:

```yaml
---
title: Answers that arrive as they are written
description: One sentence shown under the title and in the post list.
date: 2026-11-13
author: Ana Lima
---
```

Write `date` as year, month and day. It works with or without quotes. `author` is optional. Pages without a date stay ordinary pages, which is useful for an about page.

## What changes

* The layout becomes one reading column with no sidebar. Search and dark mode stay.
* `index.md` lists every post, newest first, with its date, description and reading time.
* Each post shows its date, author and reading time under the title, and links to the newer and older post.
* With `siteUrl` set, the build writes `feed.xml`, an Atom feed of the newest 30 posts with their full text, and every page links to it. Without `siteUrl` there is no feed, and the build says so.
* Hidden pages are never listed.

Folders still work, so `posts/2026/launch.md` is a fine place for a post. Its address follows the file, as with any page.

:::tip
The Docubase website's journal is built this way. See `site/blog` in the repository.
:::
