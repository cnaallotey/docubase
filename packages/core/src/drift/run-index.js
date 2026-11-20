import { indexRepo } from './codeindex.js';

/** Small seam so tests can count index runs and the index is built once per check. */
export function codeIndexFor(repoRoot, skip) {
  return indexRepo(repoRoot, { skip });
}
