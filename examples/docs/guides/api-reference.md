---
title: API reference
description: Turn an OpenAPI file into reference pages with a request playground.
order: 5
---

Point Docubase at an OpenAPI 3 file and it writes the reference for you. Nothing runs in your browser at build time, and the generated pages are ordinary pages, so they appear in the sidebar, in search, in `llms.txt` and in the assistant like everything else.

## Turn it on

Put the spec inside your docs folder and name it in `docubase.config.json`:

```json
{
  "openapi": { "spec": "openapi.yaml" }
}
```

YAML and JSON both work. Swagger 2.0 files are rejected with a message asking you to convert them first.

| Option | Default | What it does |
| --- | --- | --- |
| `spec` | none | Path to the file, inside the docs folder |
| `path` | `api` | Where the pages live, so `api` gives `/api/` |
| `title` | `API reference` | Sidebar label for the group |
| `order` | `4` | Position of the group in the sidebar |

## What you get

* An overview page with the description, base URLs, authentication and a table of every endpoint
* One page per tag, with each endpoint's parameters, request body, responses and examples
* Schema tables that follow `$ref`, merge `allOf` and stop cleanly on circular references
* Generated example bodies when the spec has none

References that point at another file are not followed. Docubase warns about them so you can bundle the spec first.

## The request playground

Each endpoint has a **Try it** box. It shows a form for the server, the path and query parameters, headers, the body and your credentials, and sends the request from the reader's browser.

* Credentials stay in memory on that page. They are not saved and are only sent to the server shown in the form.
* Requests go straight from the browser to your API, so your API must allow the docs site in its CORS settings. When it does not, the playground says so.
* The body box is shown for JSON and form bodies. File uploads are not supported.

:::note
The example API in these docs points at a server that does not exist, so its playground ends in a network error. That is expected.
:::

## Mixing with your own pages

Generated pages live under `path`. If one of your Markdown files would produce the same address, the build stops and names both files.
