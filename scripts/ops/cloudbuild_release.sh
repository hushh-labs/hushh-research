#!/usr/bin/env bash
# Compatibility entrypoint: dispatch the existing governed release workflow.
# Cloud Build diagnostics and local reports never authorize a deployment.
# Source is checked out by the workflow at the resolved immutable SHA; this
# caller's dirty worktree is neither uploaded nor executed as deployment code.
set -euo pipefail

TARGET_ENV=""
DEPLOY_SHA=""
SCOPE="auto"
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env|--sha|--scope)
      [[ $# -ge 2 && -n "$2" ]] || { echo "Missing value for $1" >&2; exit 2; }
      case "$1" in
        --env) TARGET_ENV="$2" ;;
        --sha) DEPLOY_SHA="$2" ;;
        --scope) SCOPE="$2" ;;
      esac
      shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-ci-check|--skip-migrations)
      echo "Refusing $1: required CI and migration gates belong to the governed workflow." >&2
      exit 2 ;;
    -h|--help)
      echo "Usage: $0 --env <dev|uat|production> [--sha <main-commit>] [--scope <auto|all|backend|frontend>] [--dry-run]"
      echo "Dispatches the canonical workflow; does not perform or prove a deployment locally."
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$TARGET_ENV" in dev|uat|production) ;; *) echo "--env must be dev, uat or production" >&2; exit 2 ;; esac
case "$SCOPE" in auto|all|backend|frontend) ;; *) echo "Invalid deploy scope" >&2; exit 2 ;; esac

# Read authoritative main and resolve an exact commit. Never silently reuse stale
# refs when fetching fails, or check out/switch the caller's active branch.
git fetch --no-tags origin main
DEPLOY_SHA="$(git rev-parse --verify "${DEPLOY_SHA:-origin/main}^{commit}")"
[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "Expected immutable commit SHA" >&2; exit 1; }
git merge-base --is-ancestor "$DEPLOY_SHA" origin/main || {
  echo "Refusing commit that is not reachable from origin/main" >&2; exit 1;
}

args=(workflow run "deploy-${TARGET_ENV}.yml" --repo hushh-labs/hushh-research --ref main -f "sha=${DEPLOY_SHA}" -f "scope=${SCOPE}")
# Preserve this legacy entrypoint's main-only content selection. The Dev workflow
# separately supports CI-green branch deployments through its normal entrypoint.
[[ "$TARGET_ENV" != dev ]] || args+=(-f ref=main)
if [[ "$DRY_RUN" -eq 1 ]]; then
  printf 'Governed dispatch plan: gh'; printf ' %q' "${args[@]}"; printf '\n'
  exit 0
fi
gh "${args[@]}"
printf 'Dispatch requested for %s at %s. Verify the workflow run and release receipt before claiming deployment success.\n' "$TARGET_ENV" "$DEPLOY_SHA"
