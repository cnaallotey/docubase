---
title: Roadmap
description: What works today and what is planned next.
order: 3
---

## Working now

* Markdown pages with frontmatter, callouts, tabs and syntax highlighting
* Sidebar from the folder layout, with `_meta.json` and an optional explicit sidebar
* Full text search built at build time
* Dark mode, mobile layout and a table of contents
* Link, anchor and image checks
* OpenAPI reference with a request playground
* `llms.txt`, `llms-full.txt` and a Markdown version of every page
* Ask AI on your own model key, with `docubase start`
* A local MCP server with `docubase mcp`
* A Nuxt module, `@docubase/nuxt`, with overridable components
* A Docker image, and a hosting server that builds sites from git, serves them by hostname and rebuilds on push
* Docs drift detection with `docubase check` and a GitHub Action
* Streaming Ask AI answers
* A hosted MCP endpoint, from `docubase start` and from the hosting server
* Client side navigation in the Nuxt theme
* A dashboard with sign up, site management, verified custom domains and billing through Paystack (or Stripe) for the hosting server

## Planned

1. Email for the dashboard: address confirmation, password reset and build failure notices
2. Teams, so more than one person can manage a site
3. Usage numbers per site in the dashboard: page views, assistant questions and MCP calls
