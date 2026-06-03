#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

set -euo pipefail

REPO="${GITHUB_REPO:-hushh-labs/hushh-research}"

GITHUB_REPO="$REPO" GITHUB_BRANCH="main" GITHUB_POLICY_KEY="main" \
  scripts/ci/verify-main-branch-protection.sh

GITHUB_REPO="$REPO" GITHUB_BRANCH="integration/pr-train" GITHUB_POLICY_KEY="pr_train" \
  scripts/ci/verify-main-branch-protection.sh

python3 scripts/ci/verify-pr-base-policy.py --base-ref main --head-ref integration/pr-train

if python3 scripts/ci/verify-pr-base-policy.py --base-ref main --head-ref feature/direct-main; then
  echo "ERROR: direct feature PR into main was allowed unexpectedly." >&2
  exit 1
fi

python3 scripts/ci/verify-pr-base-policy.py --base-ref integration/pr-train --head-ref feature/train-entry

echo "✅ PR train branch governance matches the documented contract."
