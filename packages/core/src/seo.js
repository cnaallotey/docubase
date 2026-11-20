/**
 * Search and link preview data for a page: canonical URL, Open Graph and X (Twitter) tags, and
 * schema.org structured data. Both the static theme and the Nuxt theme turn this into head tags.
 */

/** The full URL of a page's social image, or null when there is none or it cannot be made absolute. */
export function socialImageUrl(config, page) {
  const raw = page?.image ?? config.socialImage;
  if (!raw) return null;
  const value = encodeURI(raw.replaceAll('{page}', page?.slug || 'index'));
  if (/^https?:/i.test(value)) return value;
  if (!config.siteUrl) return null;
  return config.siteUrl + (value.startsWith('/') ? value : config.base + value);
}

/**
 * @param {object} config Normalized site config.
 * @param {{ slug: string, url: string, title: string, isPost?: boolean, date?: string|null, author?: string|null, image?: string|null }} page
 * @param {{ pageTitle: string, description: string }} text The title and description the page shows.
 * @returns {{ canonical: string|null, meta: Array<{ property?: string, name?: string, content: string }>, jsonLd: object }}
 */
export function seoTags(config, page, { pageTitle, description }) {
  const url = config.siteUrl ? config.siteUrl + page.url : null;
  const image = socialImageUrl(config, page);
  const meta = [];
  if (url) meta.push({ property: 'og:url', content: url });
  meta.push({ property: 'og:type', content: page.isPost ? 'article' : 'website' }, { property: 'og:site_name', content: config.title });
  if (image) meta.push({ property: 'og:image', content: image }, { property: 'og:image:alt', content: pageTitle });
  meta.push({ name: 'twitter:card', content: image ? 'summary_large_image' : 'summary' });
  if (config.twitter) meta.push({ name: 'twitter:site', content: config.twitter });
  if (page.isPost && page.date) meta.push({ property: 'article:published_time', content: page.date });
  if (page.isPost && page.author) meta.push({ property: 'article:author', content: page.author });

  const website = { '@type': 'WebSite', name: config.title, ...(config.siteUrl ? { url: config.siteUrl + config.base } : {}) };
  const data =
    page.slug === ''
      ? { ...website, ...(description ? { description } : {}) }
      : {
          '@type': page.isPost ? 'BlogPosting' : 'TechArticle',
          headline: page.title,
          ...(description ? { description } : {}),
          ...(url ? { url, mainEntityOfPage: url } : {}),
          ...(image ? { image } : {}),
          ...(page.isPost && page.date ? { datePublished: page.date } : {}),
          ...(page.isPost && page.author ? { author: { '@type': 'Person', name: page.author } } : {}),
          inLanguage: config.lang,
          isPartOf: website,
        };
  return { canonical: url, meta, jsonLd: { '@context': 'https://schema.org', ...data } };
}
