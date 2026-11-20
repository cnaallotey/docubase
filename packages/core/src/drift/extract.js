import matter from 'gray-matter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

const SHELL_LANGS = new Set(['sh', 'bash', 'shell', 'console', 'terminal', 'zsh']);
const MATTER_OPTIONS = {
  engines: {
    js: () => { throw new Error('JavaScript frontmatter is not supported'); },
    javascript: () => { throw new Error('JavaScript frontmatter is not supported'); },
  },
};

const parser = unified().use(remarkParse).use(remarkGfm);

/**
 * Pull everything a doc says about the code out of one Markdown file.
 * Returns a flat list of claims, each with the line it sits on in the original file.
 * Rules decide later whether a claim is true.
 */
export function extractClaims(raw) {
  const parsed = matter(raw, MATTER_OPTIONS);
  const at = raw.indexOf(parsed.content);
  const offset = at > 0 ? raw.slice(0, at).split('\n').length - 1 : 0;
  const tree = parser.parse(parsed.content);
  const claims = [];
  const line = (node) => (node.position?.start.line ?? 1) + offset;

  visit(tree, (node) => {
    if (node.type === 'inlineCode') {
      claims.push({ kind: 'inline', value: node.value.trim(), line: line(node) });
    } else if (node.type === 'link' || node.type === 'definition') {
      const href = node.url ?? '';
      if (/^https?:\/\//i.test(href)) claims.push({ kind: 'external', value: href, line: line(node) });
      else if (href && !href.startsWith('#') && !href.startsWith('/') && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
        claims.push({ kind: 'link', value: href.split('#')[0].split('?')[0], line: line(node) });
      }
    } else if (node.type === 'code') {
      if (/\bdrift-ignore\b/.test(node.meta ?? '')) return;
      const lang = (node.lang ?? '').toLowerCase();
      const first = line(node) + 1;
      if (lang === 'json') claims.push({ kind: 'json', value: node.value, line: first });
      else if (lang === 'yaml' || lang === 'yml') claims.push({ kind: 'yaml', value: node.value, line: first });
      else if (SHELL_LANGS.has(lang)) {
        node.value.split('\n').forEach((text, i) => {
          const cleaned = text.trim().replace(/^[$>]\s+/, '');
          if (!cleaned || cleaned.startsWith('#')) return;
          claims.push({ kind: 'shell', value: cleaned, line: first + i });
        });
      }
    }
  });

  return { claims, data: parsed.data };
}
