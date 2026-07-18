#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
#
# Local markdown lint mirror for docs/reference/operations/proposals/markdown-lint.workflow.yml.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to run markdownlint-cli2"
  exit 1
fi

npx --yes markdownlint-cli2 \
  "**/*.md" \
  "!.claude/**" \
  "!.codex/**" \
  "!**/node_modules/**"

echo "Markdown lint completed."
