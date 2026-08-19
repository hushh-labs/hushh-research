#!/usr/bin/env bash
# scripts/ci/tag-last-known-good.sh
#
# Marks a successful, healthy deploy as "last known good" so a future revert
# check (scripts/git/check-merge-regression.sh, via the wider comparison pass
# in the Merge Fidelity Gate) and a future rollback (rollback.yml) both have
# a durable anchor to work from. Nothing in this repo tagged a deploy before
# this script existed — only 2 git tags existed in the whole repo, neither
# part of the deploy pipeline.
#
# Writes two refs:
#   - one immutable annotated tag per successful run:
#       deployed/<env>/<sha8>-<UTC-timestamp>
#   - one moving convenience ref, force-updated each time:
#       deployed/<env>-latest
# One combined tag for both lanes (backend+frontend) rather than four
# separate per-lane tags — deliberately lightweight, since backend/frontend
# can deploy independently via the existing scope mechanism and a maintained
# per-lane changelog is not what this needs to be. If lane drift becomes a
# real operational problem, split into deployed/<env>-backend-latest /
# deployed/<env>-frontend-latest — the mechanism doesn't change, just the ref
# names.
#
# Called from deploy-uat.yml / deploy-production.yml only after the release
# classified healthy (no rollback fired). Requires `contents: write` on the
# calling workflow and a checkout with push credentials persisted (the
# actions/checkout default — do not add persist-credentials: false upstream
# of this step).
#
# Env (all required except RUN_URL/ACTOR):
#   ENVIRONMENT        uat | production
#   SHA                the commit that was deployed
#   BACKEND_REVISION, BACKEND_URL, FRONTEND_REVISION, FRONTEND_URL
#   RUN_URL            the GitHub Actions run URL, for the annotation
#   ACTOR              who dispatched the deploy
set -euo pipefail

ENVIRONMENT="${ENVIRONMENT:?ENVIRONMENT is required (uat|production)}"
SHA="${SHA:?SHA is required}"
BACKEND_REVISION="${BACKEND_REVISION:-}"
BACKEND_URL="${BACKEND_URL:-}"
FRONTEND_REVISION="${FRONTEND_REVISION:-}"
FRONTEND_URL="${FRONTEND_URL:-}"
RUN_URL="${RUN_URL:-}"
ACTOR="${ACTOR:-unknown}"

SHA8="${SHA:0:8}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TAG="deployed/${ENVIRONMENT}/${SHA8}-${TIMESTAMP}"
LATEST_REF="deployed/${ENVIRONMENT}-latest"

MESSAGE="$(cat <<EOF
Last known good — ${ENVIRONMENT}
sha: ${SHA}
backend_revision: ${BACKEND_REVISION}
backend_url: ${BACKEND_URL}
frontend_revision: ${FRONTEND_REVISION}
frontend_url: ${FRONTEND_URL}
run: ${RUN_URL}
actor: ${ACTOR}
tagged_at: ${TIMESTAMP}
EOF
)"

git tag -a "$TAG" "$SHA" -m "$MESSAGE"
git push origin "refs/tags/${TAG}"

# Force-move only this one ref, not a general force-push — deliberately
# scoped so it can never touch a branch or another tag.
git tag -fa "$LATEST_REF" "$SHA" -m "$MESSAGE"
git push origin "refs/tags/${LATEST_REF}" --force

echo "[tag-last-known-good] Tagged ${SHA8} as ${TAG} and moved ${LATEST_REF} to it."
