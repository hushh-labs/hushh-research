#!/usr/bin/env bash
set -euo pipefail

# Refuse a production iOS App Store release unless the release commit CONTAINS
# (is a descendant of, or is equal to) the latest commit that was successfully
# deployed to UAT. This enforces the promotion invariant  prod ⊇ approved-UAT:
# every public build must carry code that has already been verified on UAT.
#
# The "approved UAT SHA" is the head_sha of the most recent successful
# "Deploy to UAT" workflow run (deploy-uat.yml). Set UAT_SOURCE_SHA to override
# the lookup (tests, or a deliberate manual pin).
#
# Usage: scripts/ci/require-release-contains-uat.sh <release-commit-sha>

RELEASE_SHA="${1:-${RELEASE_SHA:-}}"
UAT_WORKFLOW="${UAT_WORKFLOW:-deploy-uat.yml}"

if [ -z "$RELEASE_SHA" ]; then
  echo "Usage: scripts/ci/require-release-contains-uat.sh <release-commit-sha>" >&2
  exit 1
fi

# 1. Resolve the approved UAT source SHA (explicit override wins).
UAT_SHA="${UAT_SOURCE_SHA:-}"
if [ -z "$UAT_SHA" ]; then
  if [ -z "${GITHUB_REPOSITORY:-}" ] || [ -z "${GITHUB_TOKEN:-}" ]; then
    echo "Refusing release: GITHUB_REPOSITORY and GITHUB_TOKEN are required to resolve the approved UAT SHA (or set UAT_SOURCE_SHA)." >&2
    exit 1
  fi
  PAYLOAD="$(curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/${UAT_WORKFLOW}/runs?status=success&per_page=1")"
  UAT_SHA="$(printf '%s' "$PAYLOAD" | python3 -c 'import json,sys; runs=(json.load(sys.stdin).get("workflow_runs") or []); print(runs[0]["head_sha"] if runs else "")')"
fi

if [ -z "$UAT_SHA" ]; then
  echo "Refusing release: could not determine the latest successful '${UAT_WORKFLOW}' commit (no successful UAT deploys?)." >&2
  exit 1
fi

# 2. Make sure both commits are present in the local clone.
for sha in "$UAT_SHA" "$RELEASE_SHA"; do
  if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    git fetch --no-tags origin "$sha" >/dev/null 2>&1 || true
  fi
  if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    echo "Refusing release: commit '$sha' is not available in the local clone." >&2
    exit 1
  fi
done

# 3. prod ⊇ approved-UAT: the release commit must contain the approved UAT commit.
#    (A commit is its own ancestor, so RELEASE_SHA == UAT_SHA is allowed.)
if ! git merge-base --is-ancestor "$UAT_SHA" "$RELEASE_SHA"; then
  echo "Refusing release: release commit '$RELEASE_SHA' does not contain the latest approved UAT commit '$UAT_SHA'." >&2
  echo "The App Store build would ship code that was never verified on UAT." >&2
  echo "Promote the release source to UAT first, or cut the release from a newer main." >&2
  exit 1
fi

echo "Release promotion preflight passed: '$RELEASE_SHA' contains approved UAT commit '$UAT_SHA'."

# 4. Publish the resolved UAT source SHA for downstream steps / job summary.
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "UAT_SOURCE_SHA=$UAT_SHA" >> "$GITHUB_ENV"
fi
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "uat_source_sha=$UAT_SHA" >> "$GITHUB_OUTPUT"
fi
