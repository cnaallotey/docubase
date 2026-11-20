---
title: Nuxt theme
description: Use your docs inside a Nuxt app with the @docubase/nuxt module.
order: 7
---

`@docubase/nuxt` is a Nuxt module. It reads your docs folder with the same core as the command line tool and renders the pages with Vue, so the docs can live inside a Nuxt app next to your own pages, layouts and components.

## Install

```bash
npm install nuxt @docubase/nuxt
```

```js
// nuxt.config.js
export default defineNuxtConfig({
  modules: ['@docubase/nuxt'],
  docubase: { dir: './docs' }
});
```

The `docs` folder, `docubase.config.json`, the OpenAPI file and the assistant settings work exactly as described in the other guides. Run `nuxt dev` to write, and `nuxt generate` to produce a static site.

## What you get

* Every page of your docs as a route, rendered on the server and prerendered by `nuxt generate`
* The same search, tabs, copy buttons, API playground and Ask AI as the default theme
* `llms.txt`, `llms-full.txt`, a Markdown version of each page and the search index, served as plain files
* Live reload in `nuxt dev` when you edit a docs file, including the Markdown routes
* Moving between docs pages without a full page load, from the sidebar, the pager, links in the content, search results and Ask AI sources

The base path comes from Nuxt's `app.baseURL`, not from the `base` option in `docubase.config.json`.

## Change the look

The module registers four components. Create a component with the same name in your own app and yours is used instead.

| Component | What it draws |
| --- | --- |
| `DocubaseLayout` | The top bar, sidebar, content area and the search and Ask dialogs |
| `DocubaseNav` | The sidebar tree |
| `DocubaseToc` | The "On this page" list |
| `DocubasePager` | Previous and next links |

The default stylesheet and its class names are loaded from the module. If you replace `DocubaseLayout` and keep those class names, the search, tabs and playground keep working. If you change them, you also need to supply your own behaviour for those parts.

## Good to know

* Links stay plain `<a>` tags in the components. One click listener sends links to known docs pages through the Nuxt router, so components you override keep this for free. Links to Markdown files, downloads, other sites, new tabs and clicks with a modifier key load normally.
* After each move the theme script runs again on the new content, focus goes to the main content area, and the sidebar keeps the current page in view. Your own scripts can call `window.Docubase.enhance()` after they change the page.
* Page data for the next page comes from the payload `nuxt generate` writes for every route. Where there is none, such as a server build, the module answers at `/__docubase/page`.
* Docs are served by one catch all route, so a Nuxt page of your own with a specific path such as `/pricing` wins over it. A docs page at that same path would then be hidden.
* Page content is rendered on the server and sent once as HTML. It is not bundled into your JavaScript. The page payload that Nuxt writes does repeat the HTML once for hydration.
* The assistant endpoint is not part of the Nuxt build. Run `docubase start` for it and set `assistant.endpoint`, see [AI and agents](./ai-and-agents.md).
