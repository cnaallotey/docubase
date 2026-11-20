# @docubase/core

The content pipeline behind [Docubase](https://www.npmjs.com/package/docubase). It reads a folder of Markdown and returns pages, navigation, a search index and the files agents read (`llms.txt`), with no opinion about how you render them. The `docubase` CLI and `@docubase/nuxt` are both built on it.

```bash
npm install @docubase/core
```

```js
import { loadSite } from '@docubase/core';

const site = await loadSite('./docs');
for (const page of site.pages) console.log(page.url, page.title);
console.log(site.nav.tree, site.warnings);
```

`loadSite` returns `config`, `pages` (with `html`, `headings`, `description` and more), `nav`, `search`, `agents` and `warnings`. The drift checker behind `docubase check` is exported as `runDrift`.

Most people want the [`docubase`](https://www.npmjs.com/package/docubase) command instead. Documentation: https://docubase.clientra.tech/docs/

## License

MIT
