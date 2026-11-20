import path from 'node:path';
import { applyBaseline, DocubaseError, readBaseline, runDrift, writeBaseline } from '@docubase/core';

const FORMATS = ['text', 'json', 'github'];
const FAIL_ON = ['error', 'warn', 'never'];

/** GitHub workflow commands need %, CR, LF and in properties also : and , escaped. */
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function formatText(result, { fresh, known, resolved }, log) {
  const byFile = new Map();
  for (const f of fresh) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  for (const [file, list] of byFile) {
    log.log(file);
    for (const f of list) log.log(`  ${String(f.line).padStart(4)}  ${f.level.padEnd(5)}  ${f.rule.padEnd(16)}  ${f.message}`);
    log.log('');
  }
  for (const note of result.notes) log.log(`note: ${note}`);
  const errors = fresh.filter((f) => f.level === 'error').length;
  const warns = fresh.length - errors;
  const parts = [`${errors} error${errors === 1 ? '' : 's'}`, `${warns} warning${warns === 1 ? '' : 's'}`];
  if (known.length) parts.push(`${known.length} in the baseline`);
  log.log(`Checked ${result.docs} page${result.docs === 1 ? '' : 's'}: ${parts.join(', ')}.`);
  if (resolved.length) log.log(`${resolved.length} baseline entr${resolved.length === 1 ? 'y no longer matches' : 'ies no longer match'} anything. Run with --update-baseline to remove ${resolved.length === 1 ? 'it' : 'them'}.`);
}

function formatGithub(result, { fresh }, log) {
  for (const f of fresh) {
    log.log(`::${f.level === 'error' ? 'error' : 'warning'} file=${escProp(f.file)},line=${f.line},title=${escProp(`docs drift: ${f.rule}`)}::${esc(f.message)}`);
  }
  for (const note of result.notes) log.log(`::notice title=docs drift::${esc(note)}`);
}

/**
 * Run the drift check and print it. Returns the process exit code.
 */
export async function check(root, options, log) {
  const { format = 'text', failOn = 'error', external = false, history = true, updateBaseline = false, baseline } = options;
  if (!FORMATS.includes(format)) throw new DocubaseError(`--format must be one of: ${FORMATS.join(', ')}.`);
  if (!FAIL_ON.includes(failOn)) throw new DocubaseError(`--fail-on must be one of: ${FAIL_ON.join(', ')}.`);

  const result = await runDrift(root, { history, external });
  let baselinePath = baseline ? path.resolve(baseline) : result.baselinePath;

  if (updateBaseline) {
    baselinePath ??= path.join(root, '.docubase-drift-baseline.json');
    const count = await writeBaseline(baselinePath, result.findings);
    log.log(`Wrote ${count} finding${count === 1 ? '' : 's'} to ${path.relative(process.cwd(), baselinePath) || baselinePath}. Commit this file. Future checks fail only on new findings.`);
    return 0;
  }

  const split = baselinePath ? applyBaseline(result.findings, await readBaseline(baselinePath)) : { fresh: result.findings, known: [], resolved: [] };

  if (format === 'json') {
    log.log(JSON.stringify({ docs: result.docs, findings: split.fresh, baselined: split.known.length, notes: result.notes }, null, 2));
  } else if (format === 'github') {
    formatGithub(result, split, log);
  } else {
    formatText(result, split, log);
  }

  if (failOn === 'never') return 0;
  const failing = split.fresh.filter((f) => f.level === 'error' || failOn === 'warn');
  return failing.length ? 1 : 0;
}
