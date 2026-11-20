# Docubase

Open source docs from a folder of Markdown. Fast pages, built in search, no account, no metered credits.

Status: all five phases of the roadmap are built, plus the follow ups that were planned. The generator, default theme and search work, and so do the OpenAPI reference, `llms.txt`, the Ask AI assistant on your own model key with streamed answers, a local and a hosted MCP server, a Nuxt module with client side navigation, a Docker image, and a hosting server with a sign up dashboard and optional Stripe billing.

## Try it

You need Node 20 or newer.

```bash
npm install
npm run dev:example      # live reload at http://127.0.0.1:3000
npm run build:example    # writes examples/docs/dist
npm run build:nuxt       # the same docs rendered by the Nuxt module, in examples/nuxt
npm test
```

### The website

`site/` is the Docubase website: animated marketing pages, the docs at `/docs/` and a journal at `/blog/`, both built with Docubase. It deploys to Cloudflare Pages.

```bash
npm run build:site     # writes site/dist
npm run preview:site   # http://127.0.0.1:8788
```

See `site/README.md` for deployment.

To test features by hand, `examples/playground` has a small API with docs that use all of them:

```bash
npm run playground:api   # the tasks API on http://127.0.0.1:4010
npm run playground:dev   # its docs on http://127.0.0.1:3001
npm run playground:host  # the hosting server and dashboard on http://app.localhost:8090
```

On your own docs:

```bash
npx docubase dev docs
npx docubase build docs --strict
npx docubase start docs      # serve the build, plus the assistant when it is on
npx docubase mcp docs        # local MCP server for coding agents
npx docubase check docs      # fail when docs describe code that is gone
```

## How it is split

| Package | What it does |
| --- | --- |
| `@docubase/core` | Framework agnostic. Reads a docs folder and returns pages, navigation, headings and a search index. No HTML theme, no framework. |
| `docubase` | The CLI and the default static theme. Turns the core output into a site. |
| `@docubase/nuxt` | A Nuxt module that renders the same core output with Vue components you can override. |
| `@docubase/host` | The managed hosting server. Builds many sites from git, serves them by hostname, rebuilds on push, runs the assistant and MCP endpoint per site, and has a dashboard with accounts and billing. |

```js
import { loadSite } from '@docubase/core';

const site = await loadSite('./docs');
site.pages;    // title, url, html, headings, sections, prev, next
site.nav.tree; // sidebar tree
site.search;   // { options, index } for MiniSearch
site.warnings; // broken links, missing images, removed HTML
site.agents;   // llms.txt, llms-full.txt and assistant chunks
```

## What works


* Markdown with GitHub tables and task lists, frontmatter, syntax highlighting
* Callouts (`note`, `tip`, `warning`, `danger`) and tabs, written with `:::` directives
* Sidebar from folders, `order` in frontmatter, `_meta.json` for folders, or an explicit `sidebar` in the config
* Section level search built at build time, runs in the browser
* Blog mode: dated posts, a post list, reading time and an Atom feed
* Link, heading anchor and image checks, with `--strict` for CI
* An editorial default theme: EB Garamond bundled with the site (SIL Open Font License, nothing loaded from other servers), forest green accent, soft sage surfaces and a painted sky behind the start page heading. The dashboard uses the same look.
* Dark mode, mobile layout, table of contents, copy buttons, keyboard search (`/` or `Ctrl K`)
* Dev server with live reload and build errors shown on the page

Phase 2 added:

* OpenAPI 3 reference pages generated from a YAML or JSON file, with a **Try it** request form per endpoint
* `llms.txt`, `llms-full.txt` and a Markdown version of every page
* **Ask AI**: answers from your docs using your own Anthropic or OpenAI compatible key (Ollama works), served by `docubase start`
* `docubase mcp`: a local MCP server with `search_docs`, `get_page` and `list_pages`

Phase 3 added:

* `@docubase/nuxt`: add the module, point it at your docs folder, and get the pages, search, playground, Ask AI, Markdown routes and `llms.txt` inside a Nuxt app. `nuxt dev` reloads when docs change and `nuxt generate` writes a static site. The layout, sidebar, contents list and pager are Vue components you can replace.

Phase 4 added:

* `docker/Dockerfile` with two targets: `docs` serves a mounted docs folder, `host` runs the hosting server. Compose files for both, and a Caddy setup that gets certificates on demand.
* `docubase-host`: an admin API, GitHub and GitLab webhooks, custom domains, per site assistant keys encrypted at rest, and builds that run in an isolated process with time, memory and size limits.

Phase 5 added:

* `docubase check`: finds docs that mention files, flags, npm scripts, environment variables, functions or endpoints that no longer exist, examples that do not parse, and pages whose `covers` code changed after the page did. Output as text, JSON or GitHub annotations, with a baseline for adopting it on an old repo.
* `action.yml`: a composite GitHub Action that runs the check on pull requests, and `.github/workflows/docs-drift.yml` as a working example.

Since then:

* **Streaming Ask AI.** Answers arrive token by token over Server-Sent Events, in the default theme and the Nuxt theme. Closing the dialog cancels the model request. Clients that do not ask for a stream still get one JSON reply.
* **Hosted MCP endpoint.** Set `"mcp": { "enabled": true }` and `docubase start`, or the hosting server, answers MCP's Streamable HTTP transport at `/__docubase/mcp` with the same read only tools as `docubase mcp`.
* **Client side navigation in Nuxt.** Docs links, search results and assistant sources move through the Nuxt router, and the theme script runs again on each new page.
* **Dashboard and billing.** `app.<base domain>` has sign up and sign in, site management, build logs, custom domains checked by DNS TXT record, assistant keys, and Paystack checkout and subscription management for a paid plan (Stripe is built in too, off until chosen). Without payment keys there are no plans.

## Not built yet

* MDX components and JSX. Raw HTML and JSX are removed and reported as warnings, on purpose.
* Email in the dashboard (address confirmation, password reset), teams, usage numbers, importers
* The drift check compares names and history, not meaning, and only reads code as text. It does not parse languages.

## Safety choices worth knowing

* Frontmatter is data only. JavaScript frontmatter is refused.
* Raw HTML in Markdown is removed, so a docs file cannot add scripts to a page.
* The accent colour must be a hex value, because it is written into the page CSS.
* The dev server listens on `127.0.0.1` unless you pass `--host`.
* `build` empties its output folder, so it refuses to write into a folder that has files in it and was not made by Docubase.
* Assistant keys come from the environment only. The config loader refuses any `assistant` option named like a key, secret, token or password.
* The assistant has a question length cap, a body size cap, a per address rate limit, an origin check and a timeout. It never calls the model when nothing in the docs matches, and it logs neither keys nor questions.
* The API playground keeps credentials in memory and sends them only to the server shown in its form.
* The MCP server is read only and writes nothing but protocol messages to stdout.
* The address guard unwraps IPv6 forms that hide an IPv4 address (mapped, NAT64, 6to4, Teredo) before judging them. Repository clones do not follow redirects. `docubase check --external` resolves every link and every redirect hop and refuses private addresses.
* SVG files are served with a policy that blocks scripts when opened directly.
* Known limits: a host that changes its DNS answer between the check and the connection can still slip past the address guard, so run the hosting server where it cannot reach internal services. Files in a site's `public` folder are served as they are, so give each site its own origin and never share cookies across the base domain.
* `docubase check` never runs your code or git hooks, reads only files inside the repository, ignores symlinks, and sends no data anywhere unless you pass `--external`, which only makes HEAD and GET requests to the links in your docs.
* Dashboard passwords are hashed with scrypt, sessions are `HttpOnly` cookies stored only as hashes, every change needs a header other sites cannot send, and the page runs under a strict content security policy. Custom domains go live only after a DNS TXT check. Stripe webhooks are verified by signature and age, and card details never reach the server.
* The hosted MCP endpoint is read only, rate limited, and refuses browser pages from other origins unless you list them.
* The hosting server treats repositories as untrusted: public https only, no credentials in addresses, git without hooks or symlinks, builds in a capped separate process, private network addresses refused, secrets encrypted per site. Its limits are listed in the managed hosting guide.

## Layout of this repo

```
packages/core       content pipeline and search index
packages/docubase   CLI, default theme, build, dev and start servers, MCP server
packages/nuxt       Nuxt module and Vue components
packages/host       hosting server (docubase-host)
docker              Dockerfile, compose files and Caddy config
examples/nuxt       the same docs rendered through the Nuxt module
examples/docs       the Docubase docs, written with Docubase
examples/playground a small tasks API with docs that use every feature, for testing by hand
```

## Licence

MIT. See `LICENSE`.
