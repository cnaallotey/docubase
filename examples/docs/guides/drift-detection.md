---
title: Docs drift detection
description: Fail a pull request when the docs mention code that no longer exists.
order: 7
---

Docs rot quietly. Someone renames a flag, deletes a script or moves a file, and the page that mentions it keeps saying the old thing. `docubase check` reads your docs and your repository together and reports the claims that no longer hold.

```bash
docubase check
```

It needs no account and sends nothing anywhere. Everything runs on your machine or in your CI.

## What it checks

| Rule | Looks at | Default |
| --- | --- | --- |
| `missing-file` | Paths in inline code and links to files, such as `packages/docubase/src/start.js` | error |
| `missing-script` | `npm run build:example` style commands against the scripts in every package.json | error |
| `missing-flag` | Flags such as `--strict` in inline code, and flags after your own command in shell blocks | error |
| `missing-env` | Names such as `ANTHROPIC_API_KEY` in inline code, and assignments in shell blocks | warn |
| `missing-symbol` | Calls such as `loadSite()` that no longer exist in the code | warn |
| `unknown-endpoint` | Lines such as `GET /bookmarks/{id}` against your OpenAPI file | error |
| `invalid-json`, `invalid-yaml` | Code blocks that do not parse | error |
| `stale` | Pages whose covered code changed after the page did | warn |
| `covers-no-match` | A `covers` pattern that matches no file | error |
| `external-link` | Links to other sites that are gone, with `--external` | warn |

Names are looked up in the code of the whole repository. Markdown files are left out of that search, so a doc cannot prove itself right by repeating its own words. `node_modules`, build output and lock files are skipped too.

Flags are only checked on commands that your own packages publish under `bin`, and in inline code that is just a flag. A `git clone --depth 1` line is never questioned.

## Say which code a page covers

Add `covers` to a page and Docubase compares git history. If a covered file has a newer commit than the page, the page is reported as stale.

```yaml
---
title: Authentication
covers:
  - src/auth/**
  - src/middleware/session.js
---
```

Patterns are relative to the repository root. The check does not say the page is wrong. It says the code moved and a person should look. Edit the page, even to fix one word, and the warning clears.

History checks need the full git history. In GitHub Actions set `fetch-depth: 0` on the checkout step. On a shallow clone the check skips staleness and prints a note instead of guessing.

## Run it in CI

The repository ships a composite action. Replace `OWNER` with the account that hosts your copy of Docubase, and add the step after checkout.

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: OWNER/docubase@v1
  with:
    path: docs
```

Findings appear as annotations on the changed lines of the pull request. The action runs the same command you run locally, so you can reproduce any result with `docubase check`. See `action.yml` for the inputs and `.github/workflows/docs-drift.yml` for a complete workflow that also checks outside links once a week.

## Adopt it on a messy repo

Run `docubase check --update-baseline` once. It writes `.docubase-drift-baseline.json` with everything that is wrong today. Set `drift.baseline` in the config to that file, commit it, and from then on only new findings fail. When you fix an old one the check tells you the entry is no longer needed.

## Silence a false alarm

Pick the smallest tool that works.

* Add `drift-ignore` after the language of a code block, as in a fence that starts with `json drift-ignore`, to skip that block.
* List exact names or patterns in `drift.ignoreTokens`. A pattern may use `*`, as in the config below.
* Turn a rule off or down in `drift.rules`.
* Set `driftIgnore: true` in a page's frontmatter to skip the whole page.
* List docs paths in `drift.ignore` to skip files.

```json
{
  "drift": {
    "rules": { "missing-symbol": "off", "stale": "error" },
    "ignoreTokens": ["search-index.json", "GET /internal/**"],
    "ignore": ["archive/**"],
    "baseline": ".docubase-drift-baseline.json"
  }
}
```

## Output and exit codes

| Option | Effect |
| --- | --- |
| `--format text` | Grouped by file, for people. The default |
| `--format json` | One JSON document, for scripts |
| `--format github` | Workflow annotations |
| `--fail-on error` | Exit 1 on errors only. The default |
| `--fail-on warn` | Exit 1 on warnings too |
| `--fail-on never` | Always exit 0, for a report only job |

## Limits

* It checks names, not meaning. A page can mention a flag that exists and still describe it wrongly.
* Inline code that names a third party tool or variable, such as `NODE_ENV`, can look like a missing name. Add it to `drift.ignoreTokens`.
* Staleness compares commit times, so a page touched by an unrelated edit counts as up to date.
