#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# With no level configured, the helper preserves the historical full local run.
# CI may set CI_VALIDATION_LEVEL and pass its already-resolved file list through
# CI_CHANGED_FILES or CI_CHANGED_FILES_FILE; this wrapper never computes a diff.
exec python3 scripts/ci/repo_governance_plan.py "$@"
