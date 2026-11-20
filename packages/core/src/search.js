import MiniSearch from 'minisearch';
import { excerpt } from './util.js';

/**
 * These options are written next to the index so the browser builds the exact same searcher.
 * Each document is one section of a page (the text under one h2), so results link to the section.
 */
export const SEARCH_OPTIONS = {
  idField: 'id',
  fields: ['title', 'heading', 'text'],
  storeFields: ['title', 'heading', 'url', 'group', 'excerpt'],
  searchOptions: {
    boost: { title: 3, heading: 2 },
    prefix: true,
    fuzzy: 0.2,
  },
};

/** Find the label of the top level group a page lives in, for display next to results. */
function groupLabel(page, tree) {
  for (const entry of tree) {
    if (entry.type === 'group' && containsSlug(entry, page.slug)) return entry.label;
  }
  return '';
}

function containsSlug(group, slug) {
  return group.items.some((e) => (e.type === 'page' ? e.slug === slug : containsSlug(e, slug)));
}

/**
 * Build the search index at build time. Hidden pages are left out.
 * @returns {{ options: typeof SEARCH_OPTIONS, index: object }}
 */
export function buildSearchIndex(pages, navTree = []) {
  const search = new MiniSearch(SEARCH_OPTIONS);
  const docs = [];

  for (const page of pages) {
    if (page.hidden) continue;
    const group = groupLabel(page, navTree);
    for (const section of page.sections) {
      docs.push({
        id: section.id ? `${page.url}#${section.id}` : page.url,
        title: page.title,
        heading: section.heading,
        text: section.text,
        url: section.id ? `${page.url}#${section.id}` : page.url,
        group,
        excerpt: excerpt(section.text || page.description, 140),
      });
    }
  }

  search.addAll(docs);
  return { options: SEARCH_OPTIONS, index: search.toJSON() };
}
