<script setup>
const route = useRoute();
const slug = [].concat(route.params.slug || []).filter(Boolean).join('/');

// Page data exists only on the server. On the client it arrives in the page payload, so the
// whole docs set is never shipped as JavaScript.
// After a client side navigation the data comes from the prerendered payload when there is one,
// and otherwise from a small server route that returns the same object.
const { data } = await useAsyncData(`docubase:${slug}`, async () => {
  if (import.meta.server) {
    const { getPage } = await import('#docubase-site');
    return getPage(slug);
  }
  return $fetch('/__docubase/page', { query: { slug } }).catch(() => null);
});

if (!data.value) {
  throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true });
}

const page = data.value.page;
const site = data.value.site;
const config = site.config;
const base = config.base;
const version = site.version;
const isHome = slug === '';
const pageTitle = isHome || page.title === config.title ? config.title : `${page.title} · ${config.title}`;
const description = page.description || config.description;

// Operation data for the API playground. It sits in an attribute, which Vue escapes, so it changes
// together with the page content when the reader moves between pages.
const apiJson = page.operations.length ? JSON.stringify(page.operations) : null;

useHead({
  htmlAttrs: {
    lang: config.lang,
    'data-base': base,
    'data-v': version,
    ...(config.assistant.enabled ? { 'data-ask': config.assistant.endpoint } : {}),
  },
  title: pageTitle,
  meta: [
    { name: 'description', content: description },
    { name: 'color-scheme', content: 'light dark' },
    { property: 'og:title', content: pageTitle },
    { property: 'og:description', content: description },
    ...(page.seo ? page.seo.meta : []),
  ],
  link: [
    { rel: 'icon', href: config.favicon ? base + config.favicon : 'data:,' },
    { rel: 'preload', href: `${base}assets/fonts/eb-garamond-latin-400-normal.woff2`, as: 'font', type: 'font/woff2', crossorigin: '' },
    { rel: 'stylesheet', href: `${base}assets/docubase.css?v=${version}` },
    { rel: 'alternate', type: 'text/markdown', href: base + page.mdPath },
    ...(page.seo && page.seo.canonical ? [{ rel: 'canonical', href: page.seo.canonical }] : []),
  ],
  style: [{ innerHTML: `:root{--accent:${config.accent}}` }],
  script: [
    ...(page.seo ? [{ type: 'application/ld+json', innerHTML: JSON.stringify(page.seo.jsonLd).replace(/</g, '\\u003c') }] : []),
    {
      innerHTML: "try{var t=localStorage.getItem('docubase-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}",
      tagPosition: 'head',
    },
  ],
});
</script>

<template>
  <DocubaseLayout :site="site" :page="page">
    <article :class="['prose', { 'is-home': isHome }]">
      <header v-if="isHome" class="page-hero">
        <h1 class="page-title">{{ page.title }}</h1>
        <p v-if="page.hasDescription" class="lead">{{ page.description }}</p>
      </header>
      <template v-else>
        <h1 class="page-title">{{ page.title }}</h1>
        <p v-if="page.hasDescription" class="lead">{{ page.description }}</p>
      </template>
      <div v-html="page.html" />
    </article>
    <div class="page-links">
      <a v-if="page.editUrl" class="edit-link" :href="page.editUrl" rel="noopener noreferrer">Edit this page</a>
      <a class="edit-link" :href="base + page.mdPath" type="text/markdown">View as Markdown</a>
    </div>
    <DocubasePager :page="page" />
    <div v-if="apiJson" id="docubase-api" hidden :data-operations="apiJson" />
    <footer v-if="config.footer" class="site-footer">{{ config.footer }}</footer>
  </DocubaseLayout>
</template>
