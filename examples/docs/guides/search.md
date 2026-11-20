---
title: Search
description: How the built in search works and what it indexes.
order: 3
---

Search runs entirely in the browser. When you build the site, Docubase writes a `search-index.json` file. The first time a reader opens search, their browser downloads that file and a small search library, then answers queries locally.

## Using it

Press `/` or `Ctrl K` (`Cmd K` on a Mac) to open search. Use the arrow keys to pick a result and press Enter to open it.

## What is indexed

Each section of a page, meaning the text under every `##` heading, is indexed on its own. Results link straight to that section. Titles count more than headings, and headings count more than body text.

Matching allows typing mistakes and partial words, so `deplo` finds a page about deployment.

Hidden pages are not indexed.

:::note
Search needs the site to be served over http. If you open the built files directly from disk, the browser blocks loading the index and search shows a message saying so.
:::
