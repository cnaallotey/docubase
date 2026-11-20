# Docubase website

The marketing pages, the docs and the journal, built into one static site for Cloudflare Pages.

| Path | Source | Built by |
| --- | --- | --- |
| `/`, `/pricing/`, `/404.html` | `site/src` | `site/build.mjs` |
| `/docs/` | `examples/docs` | Docubase |
| `/blog/` | `site/blog` | Docubase, with `"blog": true` |

```bash
npm run build:site     # writes site/dist
npm run preview:site   # serves it at http://127.0.0.1:8788
```

## Settings

`site/site.config.json`:

| Key | What it does |
| --- | --- |
| `siteUrl` | Public origin, used for the sitemap, the feed and links for agents. `SITE_URL` overrides it |
| `dashboardUrl` | Where the pricing buttons go. Defaults to the managed hosting guide |
| `githubUrl` | Adds GitHub links to the header and footer when set |
| `plans` | The Pro price, its period and the site counts shown on the pricing page |

The Pro price in this file is a placeholder. Set the real one before launch.

## Deploy to Cloudflare Pages

With Git: create a Pages project from this repository with

* Build command: `npm ci && npm run build:site`
* Build output directory: `site/dist`
* Environment variable: `SITE_URL=https://your-domain` and `NODE_VERSION=22`

From your machine, with `wrangler.toml` at the repository root:

```bash
npx wrangler login
npm run deploy:site
```

The build writes `_headers` (a strict content security policy, long caching for fingerprinted assets) and `_redirects` (`/llms.txt` points at the docs).

## Writing a post

Add a Markdown file under `site/blog/posts` with a `title`, `description` and `date`. The three newest posts also appear on the home page.

## How the motion stays fast

* No framework and no animation library. `assets/site.js` is about 17 KB before compression.
* Motion uses `transform`, `opacity` and one `clip-path`. Scroll scenes are driven by a single `requestAnimationFrame` loop that only runs while a scene is on screen.
* The sky is a small WebGL shader drawn at half resolution or less. It pauses when off screen or in a background tab, and lowers its resolution if frames take too long.
* Fonts are bundled and preloaded. There are no images, so nothing shifts while loading.
* With reduced motion turned on, everything is shown in its final state and nothing moves.
