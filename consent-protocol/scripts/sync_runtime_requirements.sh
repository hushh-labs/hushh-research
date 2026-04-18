#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

set -euo pipefail

MODE="write"
if [ "${1:-}" = "--check" ]; then
  MODE="check"
  shift
fi

if [ "$#" -gt 0 ]; then
  echo "Usage: scripts/sync_runtime_requirements.sh [--check]" >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required to sync generated requirements artifacts." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

RUNTIME_OUT="$TMP_DIR/requirements.txt"
DEV_OUT="$TMP_DIR/requirements-dev.txt"

uv export \
  --frozen \
  --format requirements.txt \
  --no-hashes \
  --no-header \
  --no-annotate \
  --no-emit-project \
  --no-dev \
  --output-file "$RUNTIME_OUT" \
  >/dev/null

uv export \
  --frozen \
  --format requirements.txt \
  --no-hashes \
  --no-header \
  --no-annotate \
  --no-emit-project \
  --only-group dev \
  --output-file "$DEV_OUT" \
  >/dev/null

prepend_header() {
  local target="$1"
  local body
  body="$(cat "$target")"
  {
    echo "# Generated from pyproject.toml + uv.lock via scripts/sync_runtime_requirements.sh"
    echo "# Contributor and CI installs must use: uv sync --frozen --group dev"
    echo ""
    printf "%s\n" "$body"
  } >"$target"
}

prepend_header "$RUNTIME_OUT"
prepend_header "$DEV_OUT"

if [ "$MODE" = "check" ]; then
  diff -u requirements.txt "$RUNTIME_OUT"
  diff -u requirements-dev.txt "$DEV_OUT"
else
  cp "$RUNTIME_OUT" requirements.txt
  cp "$DEV_OUT" requirements-dev.txt
fi
