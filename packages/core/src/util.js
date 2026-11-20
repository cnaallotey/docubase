/** Error type for problems the user can fix (bad config, bad frontmatter, duplicate pages). */
export class DocubaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DocubaseError';
  }
}

/** "getting-started" becomes "Getting Started". */
export function prettify(name) {
  return String(name)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Collapse whitespace so search text and excerpts stay compact. */
export function squash(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/** Cut text to about `max` characters on a word boundary. */
export function excerpt(text, max = 160) {
  const clean = squash(text);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}
