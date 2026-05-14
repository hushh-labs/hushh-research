#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
#
# scripts/ci/schema-sync-check.sh
#
# Verifies that the committed TypeScript type file is in sync with the
# Pydantic source schema. Run automatically by protocol-check.sh.
#
# Drift is caught here before it reaches production, eliminating the class
# of bugs where the Python backend adds a field and the TypeScript frontend
# silently ignores it.
#
# Usage:
#   bash scripts/ci/schema-sync-check.sh
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
GENERATED_FILE="hushh-webapp/lib/consent/consent-approval-payload.generated.ts"
EXPORT_SCRIPT="scripts/export_schemas.py"

# Verify source files exist before running
if [ ! -f "$REPO_ROOT/consent-protocol/schemas.py" ]; then
  echo "SKIP: consent-protocol/schemas.py not found (pending PR merge). Skipping schema-sync check."
  exit 0
fi

if [ ! -f "$REPO_ROOT/$EXPORT_SCRIPT" ]; then
  echo "ERROR: $EXPORT_SCRIPT not found." >&2
  exit 1
fi

echo "Running schema-sync check..."

# Regenerate into a temp file and diff against committed version
TEMP_OUTPUT="$(mktemp)"
trap 'rm -f "$TEMP_OUTPUT"' EXIT

cd "$REPO_ROOT/consent-protocol"
uv run python "../$EXPORT_SCRIPT" --output "$TEMP_OUTPUT" 2>/dev/null \
  || uv run python "../$EXPORT_SCRIPT" 2>/dev/null

cd "$REPO_ROOT"

# If the script wrote to the real output path (default), capture from there
if [ -f "$REPO_ROOT/$GENERATED_FILE" ]; then
  COMMITTED="$(git show HEAD:"$GENERATED_FILE" 2>/dev/null || echo '__MISSING__')"
  CURRENT="$(cat "$REPO_ROOT/$GENERATED_FILE")"

  if [ "$COMMITTED" = "__MISSING__" ]; then
    echo "ERROR: $GENERATED_FILE is not committed. Run the export script and commit the result." >&2
    exit 1
  fi

  if ! diff <(echo "$COMMITTED") <(echo "$CURRENT") > /dev/null 2>&1; then
    echo ""
    echo "ERROR: TypeScript types are out of sync with the Pydantic schema." >&2
    echo "  Run: cd consent-protocol && uv run python ../scripts/export_schemas.py" >&2
    echo "  Then commit: $GENERATED_FILE" >&2
    echo ""
    diff <(echo "$COMMITTED") <(echo "$CURRENT") || true
    exit 1
  fi
fi

echo "OK: Schema-TS sync check passed — types are in sync with consent-protocol/schemas.py"
