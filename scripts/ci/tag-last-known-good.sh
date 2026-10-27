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
# calling workflow and push credentials at this step. Production supplies a
# step-scoped GH_TOKEN via an ephemeral Git credential helper; checkout and
# application build steps retain no persisted Git credentials.
#
# Env (all required except RUN_URL/ACTOR):
#   ENVIRONMENT        uat | production
#   SHA                the commit that was deployed
#   BACKEND_REVISION, BACKEND_SERVICE_URL, FRONTEND_REVISION, FRONTEND_SERVICE_URL
#   RUN_URL            the GitHub Actions run URL, for the annotation
#   ACTOR              who dispatched the deploy
#
# Named *_SERVICE_URL, not *_URL — this repo's runtime config contract
# (scripts/ci/verify-runtime-config-contract.py) retired one specific bare
# frontend-URL env-var name repo-wide (its canonical replacement is
# APP_FRONTEND_ORIGIN). These are unrelated Cloud Run service URLs, but the
# check matches on the literal name anywhere, so a different name avoids a
# false collision.
set -euo pipefail

ENVIRONMENT="${ENVIRONMENT:?ENVIRONMENT is required (uat|production)}"
SHA="${SHA:?SHA is required}"
BACKEND_REVISION="${BACKEND_REVISION:-}"
BACKEND_SERVICE_URL="${BACKEND_SERVICE_URL:-}"
FRONTEND_REVISION="${FRONTEND_REVISION:-}"
FRONTEND_SERVICE_URL="${FRONTEND_SERVICE_URL:-}"
RUN_URL="${RUN_URL:-}"
ACTOR="${ACTOR:-unknown}"

# A qualified operational backend is distinct from historical release health.
# Only the existing confirmed activation receipt can close that transition.
if [ "$ENVIRONMENT" = production ]; then
  LATEST_EXPECTED_OID="$(python3 scripts/ci/production_backend_successor_control.py healthy \
    --sha "$SHA" --revision "$BACKEND_REVISION" \
    --activation "${OPERATIONAL_BACKEND_ACTIVATION_RECEIPT:-/tmp/prod-account-deletion-activation.json}")"
fi

SHA8="${SHA:0:8}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TAG="deployed/${ENVIRONMENT}/${SHA8}-${TIMESTAMP}"
LATEST_REF="deployed/${ENVIRONMENT}-latest"

MESSAGE="$(cat <<EOF
Last known good — ${ENVIRONMENT}
sha: ${SHA}
backend_revision: ${BACKEND_REVISION}
backend_url: ${BACKEND_SERVICE_URL}
frontend_revision: ${FRONTEND_REVISION}
frontend_url: ${FRONTEND_SERVICE_URL}
run: ${RUN_URL}
actor: ${ACTOR}
tagged_at: ${TIMESTAMP}
EOF
)"

# A fresh actions/checkout has no committer identity configured, and an
# annotated tag needs one (2026-08-19: first real run failed here with
# "empty ident name"). Scoped to this repo checkout only, never --global.
if [ -z "$(git config user.email || true)" ]; then
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
fi
if [ -z "$(git config user.name || true)" ]; then
  git config user.name "github-actions[bot]"
fi

git tag -a "$TAG" "$SHA" -m "$MESSAGE"
git push origin "refs/tags/${TAG}"

# Force-move only this one ref, not a general force-push — deliberately
# scoped so it can never touch a branch or another tag.
git tag -fa "$LATEST_REF" "$SHA" -m "$MESSAGE"
if [ "$ENVIRONMENT" = production ]; then
  git push origin "refs/tags/${LATEST_REF}" \
    "--force-with-lease=refs/tags/${LATEST_REF}:${LATEST_EXPECTED_OID}"
else
  git push origin "refs/tags/${LATEST_REF}" --force
fi

echo "[tag-last-known-good] Tagged ${SHA8} as ${TAG} and moved ${LATEST_REF} to it."
