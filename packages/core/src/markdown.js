import path from 'node:path';
import matter from 'gray-matter';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkDirective from 'remark-directive';
import remarkRehype from 'remark-rehype';
import rehypeSlug from 'rehype-slug';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import { normalizeImage } from './config.js';
import { visit, SKIP } from 'unist-util-visit';
import { toString } from 'hast-util-to-string';
import { toSlug, toUrl } from './files.js';
import { DocubaseError, excerpt, prettify, squash } from './util.js';

const CALLOUTS = {
  note: 'Note',
  tip: 'Tip',
  warning: 'Warning',
  danger: 'Danger',
};

// Frontmatter is YAML only. gray-matter can run JavaScript frontmatter by default,
// which would let a docs file execute code at build time, so those engines are disabled.
const MATTER_OPTIONS = {
  engines: {
    js: () => { throw new Error('JavaScript frontmatter is not supported'); },
    javascript: () => { throw new Error('JavaScript frontmatter is not supported'); },
  },
};

function mdText(node) {
  if (typeof node.value === 'string') return node.value;
  if (Array.isArray(node.children)) return node.children.map(mdText).join('');
  return '';
}

function isExternal(url) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || url.startsWith('//');
}

/** Turn an unknown text or leaf directive back into the text the author typed. */
function directiveToText(node) {
  const label = node.children?.length ? `[${mdText(node)}]` : '';
  return { type: 'text', value: `:${node.name}${label}` };
}

function remarkDocubase() {
  return (tree, file) => {
    const ctx = file.data.docubase;

    // The first top level "# Title" becomes the page title, so the theme can draw it once.
    const h1 = tree.children.findIndex((n) => n.type === 'heading' && n.depth === 1);
    if (h1 !== -1) {
      ctx.h1 = squash(mdText(tree.children[h1]));
      tree.children.splice(h1, 1);
    }

    let rawHtml = 0;

    visit(tree, (node, index, parent) => {
      if (node.type === 'html') {
        rawHtml += 1;
        return undefined;
      }

      if (node.type === 'containerDirective') {
        const data = (node.data ||= {});
        if (node.name in CALLOUTS) {
          data.hName = 'div';
          data.hProperties = { className: ['callout', `callout-${node.name}`], role: 'note' };
          const first = node.children[0];
          const title = first?.data?.directiveLabel
            ? node.children.shift()
            : { type: 'paragraph', children: [{ type: 'text', value: CALLOUTS[node.name] }] };
          title.data = { hName: 'p', hProperties: { className: ['callout-title'] } };
          node.children.unshift(title);
        } else if (node.name === 'tabs') {
          data.hName = 'div';
          data.hProperties = { className: ['tabs'] };
        } else if (node.name === 'tab') {
          const first = node.children[0];
          let label = '';
          if (first?.data?.directiveLabel) label = squash(mdText(node.children.shift()));
          if (!label) {
            label = 'Tab';
            ctx.warnings.push('A :::tab block has no label. Write it as :::tab[Label].');
          }
          data.hName = 'div';
          data.hProperties = { className: ['tab-panel'], dataLabel: label };
          // The label is repeated as a heading so the page still reads well without JavaScript.
          node.children.unshift({
            type: 'paragraph',
            data: { hName: 'p', hProperties: { className: ['tab-label'] } },
            children: [{ type: 'text', value: label }],
          });
        } else {
          ctx.warnings.push(`Unknown directive ":::${node.name}" was rendered as a plain block.`);
          data.hName = 'div';
          data.hProperties = { className: ['directive'] };
        }
        return undefined;
      }

      if (node.type === 'leafDirective' && node.name === 'try-it') {
        // Placeholder for the request playground. The theme replaces it, other readers ignore it.
        const n = String(node.attributes?.n ?? '');
        if (/^\d{1,5}$/.test(n)) {
          const data = (node.data ||= {});
          data.hName = 'div';
          data.hProperties = { className: ['try-it-slot'], dataOperation: n };
          node.children = [];
          return undefined;
        }
      }

      if ((node.type === 'textDirective' || node.type === 'leafDirective') && parent && typeof index === 'number') {
        parent.children[index] = directiveToText(node);
        return SKIP;
      }

      if (node.type === 'link' && typeof node.url === 'string') {
        rewriteLink(node, ctx);
      } else if (node.type === 'image' && typeof node.url === 'string') {
        rewriteImage(node, ctx);
      }
      return undefined;
    });

    if (rawHtml > 0) {
      ctx.warnings.push(
        `${rawHtml} raw HTML or JSX block${rawHtml === 1 ? ' was' : 's were'} removed. Use Markdown or directives instead.`,
      );
    }
  };
}

function rewriteLink(node, ctx) {
  const href = node.url;
  if (isExternal(href)) return;

  if (href.startsWith('#')) {
    ctx.links.push({ slug: ctx.slug, hash: href.slice(1), from: ctx.source, text: href });
    return;
  }
  if (href.startsWith('/')) {
    if (ctx.base !== '/' && !href.startsWith('//')) node.url = ctx.base.slice(0, -1) + href;
    return;
  }

  const match = href.match(/^([^?#]*)([?#].*)?$/);
  const target = match[1];
  const rest = match[2] || '';
  const ext = path.posix.extname(target).toLowerCase();
  if (ext !== '.md' && ext !== '.mdx') return;

  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(ctx.source), target));
  if (resolved.startsWith('..')) {
    ctx.warnings.push(`Link "${href}" points outside the docs folder.`);
    return;
  }
  const slug = toSlug(resolved);
  const hash = rest.includes('#') ? rest.slice(rest.indexOf('#') + 1) : '';
  node.url = toUrl(ctx.base, slug) + rest;
  ctx.links.push({ slug, hash, from: ctx.source, text: href });
}

function rewriteImage(node, ctx) {
  const url = node.url;
  if (isExternal(url)) return;
  if (url.startsWith('/')) {
    if (ctx.base !== '/' && !url.startsWith('//')) node.url = ctx.base.slice(0, -1) + url;
    return;
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(ctx.source), url));
  if (resolved.startsWith('..')) {
    ctx.warnings.push(`Image "${url}" points outside the docs folder.`);
    return;
  }
  node.url = ctx.base + resolved;
  ctx.images.push({ path: resolved, from: ctx.source });
}

function rehypeDocubase() {
  return (tree, file) => {
    const ctx = file.data.docubase;

    // Split the page at each h2 so search can link straight to a section.
    const sections = [];
    let current = { id: '', heading: '', nodes: [] };
    for (const node of tree.children) {
      if (node.type === 'element' && node.tagName === 'h2' && node.properties?.id) {
        sections.push(current);
        current = { id: String(node.properties.id), heading: squash(toString(node)), nodes: [] };
      } else {
        current.nodes.push(node);
      }
    }
    sections.push(current);
    ctx.sections = sections
      .map((s) => ({ id: s.id, heading: s.heading, text: squash(s.nodes.map((n) => toString(n)).join(' ')) }))
      .filter((s) => s.text || s.heading);
    ctx.text = squash(ctx.sections.map((s) => `${s.heading} ${s.text}`).join(' '));

    const headings = [];
    visit(tree, 'element', (node) => {
      if (/^h[2-4]$/.test(node.tagName) && node.properties?.id) {
        const id = String(node.properties.id);
        headings.push({ depth: Number(node.tagName[1]), id, text: squash(toString(node)) });
        node.children.push({
          type: 'element',
          tagName: 'a',
          properties: { className: ['anchor'], href: `#${id}`, ariaLabel: 'Link to this section' },
          children: [{ type: 'text', value: '#' }],
        });
      }
      if (node.tagName === 'a' && typeof node.properties?.href === 'string' && /^https?:/i.test(node.properties.href)) {
        node.properties.rel = ['noopener', 'noreferrer'];
      }
      if (node.tagName === 'img') node.properties.loading = 'lazy';
    });
    ctx.headings = headings;
  };
}

/** One processor can be reused for every page. */
export function createProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkDirective)
    .use(remarkDocubase)
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(rehypeHighlight, { detect: false, ignoreMissing: true })
    .use(rehypeDocubase)
    .use(rehypeStringify);
}

export function normalizeFrontmatter(data, source) {
  const fm = {};
  if (data.title !== undefined) {
    if (typeof data.title !== 'string') throw new DocubaseError(`${source}: frontmatter "title" must be a string`);
    fm.title = data.title;
  }
  if (data.description !== undefined) {
    if (typeof data.description !== 'string') throw new DocubaseError(`${source}: frontmatter "description" must be a string`);
    fm.description = data.description;
  }
  if (data.image !== undefined) {
    fm.image = normalizeImage(data.image, 'image', (message) => {
      throw new DocubaseError(`${source}: frontmatter ${message}`);
    });
  }
  if (data.order !== undefined) {
    if (typeof data.order !== 'number' || Number.isNaN(data.order)) {
      throw new DocubaseError(`${source}: frontmatter "order" must be a number`);
    }
    fm.order = data.order;
  }
  if (data.hidden !== undefined) {
    if (typeof data.hidden !== 'boolean') throw new DocubaseError(`${source}: frontmatter "hidden" must be true or false`);
    fm.hidden = data.hidden;
  }
  if (data.covers !== undefined) {
    const list = typeof data.covers === 'string' ? [data.covers] : data.covers;
    const ok = Array.isArray(list) && list.length > 0 && list.every((g) => typeof g === 'string' && g.trim());
    if (!ok) throw new DocubaseError(`${source}: frontmatter "covers" must be a path pattern or a list of them, such as src/auth/**`);
    for (const glob of list) {
      if (glob.startsWith('/') || /^[a-zA-Z]:/.test(glob) || glob.split(/[\\/]/).includes('..')) {
        throw new DocubaseError(`${source}: frontmatter "covers" patterns must be relative to the repository and cannot contain ..`);
      }
    }
    fm.covers = list.map((g) => g.trim());
  }
  if (data.driftIgnore !== undefined) {
    if (typeof data.driftIgnore !== 'boolean') throw new DocubaseError(`${source}: frontmatter "driftIgnore" must be true or false`);
    fm.driftIgnore = data.driftIgnore;
  }
  if (data.date !== undefined) {
    // YAML reads an unquoted 2026-11-20 as a date, a quoted one as text. Both are accepted.
    const value = data.date instanceof Date && !Number.isNaN(data.date.getTime()) ? data.date.toISOString().slice(0, 10) : data.date;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
      throw new DocubaseError(`${source}: frontmatter "date" must be a date such as 2026-11-20`);
    }
    fm.date = value;
  }
  if (data.author !== undefined) {
    if (typeof data.author !== 'string' || !data.author.trim()) throw new DocubaseError(`${source}: frontmatter "author" must be a name`);
    fm.author = data.author.trim();
  }
  return fm;
}

/**
 * Compile one Markdown file into a page.
 * @param {{ source: string, raw: string, base?: string, processor?: ReturnType<typeof createProcessor> }} input
 */
export async function compilePage({ source, raw, base = '/', processor = createProcessor() }) {
  let parsed;
  try {
    parsed = matter(raw, MATTER_OPTIONS);
  } catch (error) {
    throw new DocubaseError(`${source}: invalid frontmatter (${error.reason || error.message})`);
  }
  const fm = normalizeFrontmatter(parsed.data, source);
  const slug = toSlug(source);
  const isIndex = /(^|\/)index\.(md|mdx)$/i.test(source);

  const ctx = { source, slug, base, warnings: [], links: [], images: [] };
  const file = await processor.process({ value: parsed.content, path: source, data: { docubase: ctx } });

  const fallbackName = slug ? slug.split('/').at(-1) : 'Home';
  const title = fm.title ?? ctx.h1 ?? prettify(fallbackName);
  const firstText = ctx.sections.find((s) => s.text)?.text ?? '';

  return {
    source,
    mdPath: source.replace(/\.mdx$/i, '.md'),
    slug,
    url: toUrl(base, slug),
    isIndex,
    title,
    description: fm.description ?? excerpt(firstText),
    hasDescription: fm.description !== undefined,
    order: fm.order ?? null,
    hidden: fm.hidden ?? false,
    covers: fm.covers ?? [],
    driftIgnore: fm.driftIgnore ?? false,
    date: fm.date ?? null,
    author: fm.author ?? null,
    image: fm.image ?? null,
    readingMinutes: Math.max(1, Math.round(String(ctx.text || '').split(/\s+/).filter(Boolean).length / 230)),
    markdown: parsed.content,
    html: String(file),
    headings: ctx.headings,
    sections: ctx.sections,
    text: ctx.text,
    links: ctx.links,
    images: ctx.images,
    warnings: ctx.warnings.map((message) => `${source}: ${message}`),
  };
}
