---
title: AI and agents
description: llms.txt, Markdown pages, a docs assistant on your own key, and a local MCP server.
order: 6
---

Docubase gives people and tools four ways to read your docs without scraping HTML.

## Markdown for every page

Each page is also written as plain Markdown next to its HTML. `guides/writing.md` in your folder is served at `/guides/writing.md`, and every page links to its Markdown version in the page head and under the content. Coding agents can fetch that file directly.

## llms.txt and llms-full.txt

Every build writes two files at the site root:

* `llms.txt` is a short index in the llms.txt format, grouped like your sidebar, with a link and description for each page
* `llms-full.txt` is every visible page in one file, for loading into a model at once

Set `siteUrl` in the config so the links are absolute:

```json
{ "siteUrl": "https://docs.example.com" }
```

Pages marked `hidden: true` are left out of both files, from search, and from the assistant.

## Ask AI, with your own key

Docubase can add an **Ask AI** button that answers questions from your docs. It uses the model account you already pay for. There is no Docubase service in the middle.

```json
{
  "assistant": {
    "enabled": true,
    "provider": "anthropic",
    "model": "your-model-name"
  }
}
```

Set the key in the environment of the server that runs the assistant:

```bash
export ANTHROPIC_API_KEY=your-key
docubase build
docubase start
```

:::warning
The key is never read from `docubase.config.json`. Any option whose name contains `key`, `secret`, `token` or `password` is refused, so a key cannot end up in your repository by accident.
:::

How it works:

1. A question is matched against your docs with the same search engine the site uses.
2. The best sections are sent to your model with the question and a short instruction to answer only from them.
3. The reply and links to the source sections go back to the reader.
4. If nothing in the docs matches, the model is not called at all.

Providers:

| `provider` | Key variable | Notes |
| --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` | Uses the Messages API |
| `openai` | `OPENAI_API_KEY` | Any OpenAI compatible server. Set `baseUrl` to use Ollama or another host, and the key becomes optional |

`DOCUBASE_API_KEY` works for either provider and wins when both are set.

Protections built in: a cap on question length, a request body limit, a per address rate limit, a 30 second timeout, and a check that only your own site, or origins listed in `allowedOrigins`, can call the endpoint. Errors from the provider are reduced to a generic message, and neither the key nor the question is written to the log.

Answers stream into the dialog as the model writes them, using Server-Sent Events. The sources arrive first, then the text, so a reader can open a linked page before the answer is finished. Closing the dialog stops the request to your model, so you do not pay for tokens nobody reads. Answers are plain text with code blocks, and they can be wrong, so every answer links the pages it used.

The endpoint streams when the request sends `Accept: text/event-stream`, and answers with one JSON object otherwise:

```bash
curl -N http://127.0.0.1:3000/__docubase/ask \
  -H "Content-Type: application/json" -H "Accept: text/event-stream" \
  -d '{"question":"How do I deploy?"}'
```

The stream sends a `sources` event, then `delta` events with `{"text": ...}`, then `done`. If the provider fails before any text arrives you get an ordinary error status. If it fails midway the stream ends with an `error` event, and the reader keeps the text so far.

### Static hosting

`docubase start` serves the built site and the assistant together. If your site is on a static host, run `docubase start` somewhere else and point the site at it:

```json
{
  "assistant": {
    "enabled": true,
    "provider": "anthropic",
    "model": "your-model-name",
    "endpoint": "https://ask.example.com/__docubase/ask",
    "allowedOrigins": ["https://docs.example.com"]
  }
}
```

Behind a reverse proxy, set `trustProxy` to `true` so the rate limit sees each reader's address instead of the proxy's.

## Local MCP server

`docubase mcp` runs a Model Context Protocol server over stdio, so an editor or coding agent can search and read your docs on your own machine. It needs no network and no key.

```bash
npx docubase mcp ./docs
```

It offers three read only tools: `search_docs`, `get_page` and `list_pages`. Add `--watch` to reload when files change.

Example client configuration:

```json
{
  "mcpServers": {
    "my-docs": { "command": "npx", "args": ["docubase", "mcp", "./docs"] }
  }
}
```

A hosted, remote MCP endpoint is not part of this version.

## Hosted MCP endpoint

The local server above runs on your machine. To let agents read your docs over the network instead, turn on the hosted endpoint:

```json
{
  "mcp": { "enabled": true }
}
```

`docubase build` then writes `docubase-mcp.json`, and `docubase start` answers the Model Context Protocol at `/__docubase/mcp`, with the same three tools. The managed hosting server does the same for every site that turns it on.

```json
{
  "mcpServers": {
    "my-docs": { "type": "http", "url": "https://docs.example.com/__docubase/mcp" }
  }
}
```

It uses the Streamable HTTP transport without sessions: each POST carries JSON-RPC messages and gets JSON replies, and GET answers 405 because the server never pushes messages. It is read only, and everything it returns is already public on your site.

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `false` | Turns the endpoint on |
| `rateLimitPerMinute` | `120` | Requests per minute for one address |
| `allowedOrigins` | none | Web pages on other sites allowed to call it. Tools that send no `Origin` are always allowed |
| `trustProxy` | `false` | Read the caller's address from `X-Forwarded-For` |

`"mcp": true` is short for `{ "enabled": true }`.
