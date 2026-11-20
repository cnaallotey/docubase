# docubase

Open source docs from a folder of Markdown. One command gives you a fast static site with search, a dark mode, an OpenAPI reference, `llms.txt` and an MCP server for coding agents, and Ask AI on your own model key.

```bash
npx docubase dev docs      # live preview at http://127.0.0.1:3000
npx docubase build docs    # static site in docs/dist
```

No account and no metered credits. The output is plain HTML, CSS and a little JavaScript that any host can serve.

## Commands

| Command | What it does |
| --- | --- |
| `docubase dev [folder]` | Preview with live reload |
| `docubase build [folder]` | Build the static site, with `--strict` to fail on warnings |
| `docubase start [folder]` | Serve a build, with the Ask AI and MCP endpoints when they are on |
| `docubase mcp [folder]` | Run an MCP server over stdio so agents can search and read the docs |
| `docubase check [folder]` | Find pages that mention files, flags, scripts or endpoints that no longer exist |

## What a site gets

* Folders become the sidebar. Links, anchors and images are checked at build time.
* Search built into the site, which works offline.
* Callouts, tabs and highlighted code in plain Markdown.
* Every page also published as Markdown, with `llms.txt` and `llms-full.txt`.
* Canonical URLs, Open Graph and X card tags, and structured data.
* Blog mode with dated posts and an Atom feed.

Settings live in an optional `docubase.config.json` in the docs folder.

Documentation: https://docubase.clientra.tech/docs/

## License

MIT
