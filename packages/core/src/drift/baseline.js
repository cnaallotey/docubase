import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DocubaseError } from '../util.js';

export const findingKey = (f) => `${f.rule}|${f.file}|${f.token}`;

/** Keys of findings the team has agreed to live with for now. A missing file means none. */
export async function readBaseline(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw error;
  }
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data.findings) || data.findings.some((k) => typeof k !== 'string')) throw new Error('"findings" must be a list of strings');
    return new Set(data.findings);
  } catch (error) {
    throw new DocubaseError(`${path.basename(file)}: not a valid baseline file (${error.message})`);
  }
}

export async function writeBaseline(file, findings) {
  const keys = [...new Set(findings.map(findingKey))].sort();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ version: 1, findings: keys }, null, 2)}\n`);
  return keys.length;
}

/** Split findings into new ones and ones already in the baseline. Also report baseline entries that no longer match anything. */
export function applyBaseline(findings, keys) {
  const fresh = [];
  const known = [];
  const hit = new Set();
  for (const f of findings) {
    const key = findingKey(f);
    if (keys.has(key)) {
      known.push(f);
      hit.add(key);
    } else fresh.push(f);
  }
  return { fresh, known, resolved: [...keys].filter((k) => !hit.has(k)) };
}
