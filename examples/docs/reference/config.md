---
title: Configuration
description: Every option in docubase.config.json.
order: 1
---

Put `docubase.config.json` in your docs folder. Every field is optional.

## Options

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `title` | string | `Docs` | Site name shown in the top bar and the browser tab |
| `description` | string | empty | Used as the page description when a page has none |
| `lang` | string | `en` | Language code written to the page |
| `base` | string | `/` | Path the site is served from, for example `/docs/` |
| `outDir` | string | `dist` | Output folder, relative to the docs folder |
| `links` | list | none | Top bar links, each with a `label` and an `href` |
| `editUrl` | string | none | Adds an "Edit this page" link. Must contain `{path}` |
| `footer` | string | empty | Text shown under every page |
| `sidebar` | list | automatic | Replaces the generated sidebar, see [Navigation](../guides/navigation.md) |
| `theme.accent` | hex colour | `#2f5d46` | Accent colour for links, buttons and the brand mark |
| `siteUrl` | string | none | Public address of the site, used for absolute links in `llms.txt` |
| `openapi` | object | none | Builds a reference from an OpenAPI file, see [API reference](../guides/api-reference.md) |
| `assistant` | object | off | The Ask AI button, see below |
| `blog` | true or false | off | Publish the folder as a blog, see [Blog](../guides/blog.md) |
| `mcp` | object or true | off | The hosted MCP endpoint served by `docubase start`, see [AI and agents](../guides/ai-and-agents.md#hosted-mcp-endpoint) |
| `drift` | object | none | Settings for `docubase check`, see below |

## Assistant options

These go inside `assistant`. See [AI and agents](../guides/ai-and-agents.md) for how it works. Keys are never set here.

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `false` | Turns on the Ask AI button and the endpoint |
| `provider` | `anthropic` | `anthropic`, or `openai` for any OpenAI compatible server |
| `model` | none | Model name to use. Required when enabled |
| `baseUrl` | provider default | Alternative API address, for example a local Ollama |
| `endpoint` | `/__docubase/ask` | Where the browser sends questions. Use a full URL when the assistant runs on another server |
| `rateLimitPerMinute` | `20` | Questions per minute for one address |
| `maxQuestionLength` | `500` | Longest question accepted |
| `allowedOrigins` | none | Other sites allowed to call the endpoint |
| `trustProxy` | `false` | Read the reader's address from `X-Forwarded-For` |

## Drift options

These go inside `drift`. See [Docs drift detection](../guides/drift-detection.md). All are optional.

| Option | Default | What it does |
| --- | --- | --- |
| `repo` | nearest folder with `.git` | Repository root, relative to the docs folder |
| `rules` | see the guide | Set a rule to `error`, `warn` or `off`, for example `{ "stale": "off" }` |
| `ignoreTokens` | none | Names, paths or endpoints to leave alone. `*` works as a wildcard |
| `ignore` | none | Docs paths to skip, such as `archive/**` |
| `baseline` | none | File of known findings that should not fail the check |
| `external.ignore` | none | Link prefixes to skip when checking outside links |
| `external.timeoutMs` | `8000` | How long to wait for each outside link |

## Example

```json
{
  "title": "Acme API",
  "base": "/docs/",
  "links": [{ "label": "GitHub", "href": "https://github.com/acme/api" }],
  "editUrl": "https://github.com/acme/api/edit/main/docs/{path}",
  "theme": { "accent": "#0f766e" }
}
```

:::warning
Invalid values stop the build with a message that names the option. This is deliberate, so a typo never silently produces a broken site.
:::
