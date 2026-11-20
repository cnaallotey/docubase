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

## Deploy to Cloudflare

The site is a Worker with static assets (`wrangler.toml` at the repository root), so `_headers`, `_redirects` and the 404 page work as written.

With Git, in Workers and Pages, import this repository and set:

* Build command: `npm ci && npm run build:site`
* Deploy command: `npx wrangler deploy`
* Path: `/`
* API token: create a new one for this project. It needs the Workers Scripts and artifacts permissions, which the token creator in that form adds for you
* Variables: `SITE_URL=https://your-domain` and `NODE_VERSION=22`

From your machine:

```bash
npx wrangler login
npm run deploy:site
```

The build writes `_headers` (a strict content security policy, long caching for fingerprinted assets) and `_redirects` (`/llms.txt` points at the docs).

## Writing a post

Add a Markdown file under `site/blog/posts` with a `title`, `description` and `date`. The three newest posts also appear on the home page.

## The look

A white page with black stage cards, cream panels, Geist type and one electric yellow accent (`--accent` in `assets/site.css`).

* **Dot fields.** Each stage holds a `<canvas data-dots="hero|page|cta|edge">`. `assets/scene.js` (raw WebGL, no library) draws a grid of square dots on a plane in perspective, lifted by travelling waves, with a brighter ribbon running diagonally through it. Crests turn yellow and the pointer lights the dots under it. The variant picks the ribbon's path and the camera.
* **Shared blocks.** `src/_plans.html` and `src/_faq.html` are used by both the home page and pricing. `{{arrow}}` is the round arrow inside buttons.
* **Docs and journal.** Docubase builds them with its own theme. The site build then adds `assets/docs-skin.css` to every one of those pages, after the theme, so they get the same type, colours, pill top bar and a black stage on each start page. The skin covers light and dark.

## How the motion stays fast

* No framework, no 3D library and no images. `scene.js` is about 10 KB and `site.js` about 13 KB before compression.
* Each dot field is one draw call with all the motion in the vertex shader. A field only draws while it is on screen and the tab is visible, and it lowers its resolution if frames take too long.
* Page motion uses `transform`, `opacity` and `filter`. Loops in the page (the search demo, the build log, the MCP terminal) stop when they are off screen.
* Without WebGL the stages stay black and the page reads normally. With reduced motion turned on, each field draws one still frame and nothing else moves.
