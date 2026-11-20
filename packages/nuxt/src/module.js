import { watch } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { addComponentsDir, addPlugin, addServerHandler, addTemplate, createResolver, defineNuxtModule, extendPages, updateTemplates } from '@nuxt/kit';
import { loadSite } from '@docubase/core';
import { writeSupportFiles } from 'docubase/src/build.js';

/** The part of a loaded site the Vue theme needs. Search text, source and link lists stay behind. */
function toSiteData(site, version) {
  const { config } = site;
  const pages = {};
  for (const page of site.pages) {
    pages[page.slug] = {
      slug: page.slug,
      url: page.url,
      title: page.title,
      description: page.description,
      hasDescription: page.hasDescription,
      html: page.html,
      headings: page.headings,
      prev: page.prev ?? null,
      next: page.next ?? null,
      editUrl: page.editUrl ?? null,
      mdPath: page.mdPath,
      operations: page.api ? page.api.operations : [],
    };
  }
  return {
    version,
    config: {
      title: config.title,
      description: config.description,
      lang: config.lang,
      base: config.base,
      links: config.links,
      footer: config.footer,
      accent: config.theme.accent,
      favicon: site.favicon,
      assistant: {
        enabled: config.assistant.enabled,
        endpoint: config.assistant.endpoint || `${config.base}__docubase/ask`,
        maxQuestionLength: config.assistant.maxQuestionLength,
      },
    },
    tree: site.nav.tree,
    pages,
  };
}

export default defineNuxtModule({
  meta: { name: '@docubase/nuxt', configKey: 'docubase', compatibility: { nuxt: '>=3.13.0' } },
  defaults: { dir: 'docs' },
  async setup(options, nuxt) {
    const { resolve } = createResolver(import.meta.url);
    const docsDir = path.resolve(nuxt.options.rootDir, options.dir);
    const baseURL = nuxt.options.app.baseURL || '/';

    // The base path comes from Nuxt, so docs links and Nuxt's own assets always agree.
    const load = () => loadSite(docsDir, { configOverrides: { base: baseURL } });
    let site = await load();
    for (const warning of site.warnings) console.warn(`[docubase] warning: ${warning}`);

    // Theme files, search index, Markdown routes and llms files are served as plain public files.
    // Written outside the build folder, because Nuxt empties that folder after modules have run.
    // This folder is owned by Docubase, so it is cleared and rewritten on every load.
    const publicDir = path.join(nuxt.options.rootDir, 'node_modules', '.cache', 'docubase', 'public');
    const writePublic = async () => {
      await rm(publicDir, { recursive: true, force: true });
      await mkdir(publicDir, { recursive: true });
      return writeSupportFiles(site, publicDir);
    };
    let { version } = await writePublic();
    nuxt.options.nitro.publicAssets = [...(nuxt.options.nitro.publicAssets || []), { dir: publicDir, baseURL: '/', maxAge: 0 }];

    // Server only data module. The page component imports it behind `import.meta.server`,
    // so page HTML is never bundled into client JavaScript.
    const siteTemplate = addTemplate({
      filename: 'docubase/site.mjs',
      write: true,
      getContents: () => `const data = ${JSON.stringify(toSiteData(site, version))};
export function getPage(slug) {
  const page = data.pages[slug];
  if (!page) return null;
  return { page, site: { version: data.version, config: data.config, tree: data.tree } };
}
export const routes = ${JSON.stringify(site.pages.map((p) => p.slug))};
`,
    });
    nuxt.options.alias['#docubase-site'] = siteTemplate.dst;
    nuxt.options.nitro.alias = { ...(nuxt.options.nitro.alias || {}), '#docubase-site': siteTemplate.dst };

    // The client only learns which addresses are docs pages, so it can move between them without a reload.
    const routesTemplate = addTemplate({
      filename: 'docubase/routes.mjs',
      write: true,
      getContents: () => `export const urls = ${JSON.stringify(site.pages.map((p) => p.url))};\n`,
    });
    nuxt.options.alias['#docubase-routes'] = routesTemplate.dst;

    // Page data for client side navigation where no prerendered payload exists, such as in nuxt dev.
    addServerHandler({ route: '/__docubase/page', method: 'get', handler: resolve('./runtime/server/page.get.js') });

    nuxt.options.pages = true;
    extendPages((pages) => {
      pages.push({ name: 'docubase-page', path: '/:slug(.*)*', file: resolve('./runtime/pages/docs.vue') });
    });
    addComponentsDir({ path: resolve('./runtime/components'), pathPrefix: false });
    addPlugin({ src: resolve('./runtime/plugins/docubase.client.js'), mode: 'client' });

    nuxt.options.nitro.prerender = nuxt.options.nitro.prerender || {};
    const routes = site.pages.map((p) => (p.slug ? `/${p.slug}` : '/'));
    nuxt.options.nitro.prerender.routes = [...(nuxt.options.nitro.prerender.routes || []), ...routes];

    // Components read these from the public runtime config.
    nuxt.options.runtimeConfig.public.docubase = { version };

    if (nuxt.options.dev) {
      let timer = null;
      const watcher = watch(docsDir, { recursive: true }, (_event, filename) => {
        if (!filename || filename.split(path.sep).some((p) => p === 'node_modules' || p === '.git' || p === 'dist')) return;
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try {
            site = await load();
            ({ version } = await writePublic());
            await updateTemplates({ filter: (t) => t.filename === 'docubase/site.mjs' || t.filename === 'docubase/routes.mjs' });
            console.log(`[docubase] reloaded ${site.pages.length} pages`);
          } catch (error) {
            console.error(`[docubase] error: ${error.message}`);
          }
        }, 150);
      });
      nuxt.hook('close', () => {
        clearTimeout(timer);
        watcher.close();
      });
    }
  },
});
