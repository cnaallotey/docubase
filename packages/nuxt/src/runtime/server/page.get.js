import { defineEventHandler, getQuery, createError } from 'h3';
import { getPage } from '#docubase-site';

// Page data for client side navigation when a page was not prerendered, such as in `nuxt dev`
// or a server build. A generated site reads the same data from each page's payload instead.
export default defineEventHandler((event) => {
  const slug = String(getQuery(event).slug ?? '').replace(/^\/+|\/+$/g, '');
  if (slug.length > 500) throw createError({ statusCode: 400, statusMessage: 'Slug too long' });
  const data = getPage(slug);
  if (!data) throw createError({ statusCode: 404, statusMessage: 'Page not found' });
  event.node.res.setHeader('cache-control', 'no-cache');
  return data;
});
