import { urls } from '#docubase-routes';

// The default theme script adds search, tabs, copy buttons, the API playground and Ask AI by
// enhancing the DOM. It is loaded after Vue has hydrated, so the two never touch the DOM at once,
// and it is asked to enhance again after every client side navigation.
export default defineNuxtPlugin((nuxtApp) => {
  const router = useRouter();
  const base = useRuntimeConfig().app.baseURL || '/';
  const docs = new Set(urls);

  /** The router path for a docs URL on this site, or null when the link should load normally. */
  function routeFor(href) {
    let url;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return null;
    }
    if (url.origin !== window.location.origin || !url.pathname.startsWith(base)) return null;
    const pagePath = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    if (!docs.has(pagePath)) return null;
    return { path: `/${pagePath.slice(base.length)}`, search: url.search, hash: url.hash, samePage: url.pathname === window.location.pathname && url.search === window.location.search };
  }

  function navigate(href) {
    const target = routeFor(href);
    if (!target) {
      window.location.href = href;
      return;
    }
    router.push(target.path + target.search + target.hash);
  }

  window.Docubase = window.Docubase || {};
  window.Docubase.navigate = navigate;

  // One listener for every docs link: sidebar, pager, page content, search results and Ask AI sources.
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self') || link.getAttribute('type') === 'text/markdown') return;
    const target = routeFor(link.href);
    if (!target || (target.samePage && target.hash)) return; // a jump within the page is left to the browser
    event.preventDefault();
    router.push(target.path + target.search + target.hash);
  });

  let navigated = false;
  router.afterEach((to, from) => {
    if (from.matched.length && to.path !== from.path) navigated = true;
  });

  nuxtApp.hook('page:finish', () => {
    nextTick(() => {
      if (window.Docubase.enhance) window.Docubase.enhance({ navigated });
      if (!navigated) return;
      navigated = false;
      // Keep the sidebar on the current page, and move focus to the new content for screen readers.
      const current = document.querySelector('.sidebar [aria-current="page"]');
      if (current) current.scrollIntoView({ block: 'nearest' });
      if (!window.location.hash) {
        const main = document.getElementById('content');
        if (main) main.focus({ preventScroll: true });
      }
    });
  });

  nuxtApp.hook('app:mounted', () => {
    if (document.querySelector('script[data-docubase-theme]')) return;
    const root = document.documentElement;
    const script = document.createElement('script');
    script.src = `${root.getAttribute('data-base') || '/'}assets/docubase.js?v=${root.getAttribute('data-v') || ''}`;
    script.setAttribute('data-docubase-theme', '');
    document.body.appendChild(script);
  });
});
