#!/bin/sh
# Build the docs mounted at $DOCS_DIR, then serve them. Runs as the unprivileged "node" user.
set -eu

DOCS_DIR="${DOCS_DIR:-/docs}"
OUT_DIR="${OUT_DIR:-/site}"
CLI="${DOCUBASE_CLI:-/app/packages/docubase/bin/docubase.js}"

if [ ! -d "$DOCS_DIR" ] || [ -z "$(ls -A "$DOCS_DIR" 2>/dev/null)" ]; then
  echo "error: there is nothing in $DOCS_DIR. Mount your docs folder, for example: -v \"\$(pwd)/docs:/docs:ro\"" >&2
  exit 1
fi

node "$CLI" build "$DOCS_DIR" --out "$OUT_DIR"
exec node "$CLI" start "$DOCS_DIR" --out "$OUT_DIR" --host 0.0.0.0 --port "${PORT:-3000}"
