#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/ci/orchestrate.sh <secret|governance|web-core|web-targeted|web-full|web|protocol|mcp-package|integration|smoke|all|advisory>

Environment flags:
  INCLUDE_ADVISORY_CHECKS=1   Also run advisory checks when stage=all

Description:
  Canonical CI stage orchestrator used by GitHub Actions and local CI wrappers.
  The default "all" stage mirrors only the blocking CI surface.
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "$#" -lt 1 ]; then
  usage
  exit 0
fi

STAGE="${1:-}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Activate the tracked git hooks, because nothing else ever did.
#
# `.githooks/prepare-commit-msg` appends a DCO signoff and has been tracked and
# correct for a long time. `core.hooksPath` is per-clone local config that git
# will not read from a checked-in file, so the hook never ran, and 78 commits
# reached the remote unsigned while the fix sat in the tree.
#
# Four remedies for this already existed -- `scripts/setup-hooks.sh`,
# `consent-protocol/ops/monorepo/setup.sh`, `./bin/hushh protocol setup`, and a
# `verify_setup` that prints a red cross for it. Every one of them required
# somebody to remember to run it, and so none of them ever ran. This is the same
# defect the pod work keeps finding: a component that passes inspection and has
# never executed.
#
# It goes HERE because this script is the one thing that is run before every
# push (CLAUDE.md makes it the standing pre-push gate), which is what breaks the
# circularity -- a hook cannot install itself, and a document cannot install it
# either.
#
# Self-healing rather than failing: CI checks out with no local config and
# legitimately has no hooks path, and a gate that fails for a reason the runner
# cannot fix is a gate people learn to route around. The write is local to one
# clone, reversible, and idempotent.
activate_tracked_git_hooks() {
  [ -z "${CI:-}" ] || return 0
  [ -z "${GITHUB_ACTIONS:-}" ] || return 0
  [ -e "$REPO_ROOT/.git" ] || return 0
  [ -d "$REPO_ROOT/.githooks" ] || return 0

  local current
  current="$(git config --get core.hooksPath 2>/dev/null || true)"
  [ -z "$current" ] || return 0

  git config core.hooksPath .githooks
  echo "== git hooks activated (core.hooksPath -> .githooks) =="
  echo "   The DCO signoff hook was tracked but inert in this clone; it runs now."
}

activate_tracked_git_hooks

run_stage() {
  local stage="$1"
  case "$stage" in
    secret)
      scripts/ci/secret-scan.sh
      ;;
    governance)
      scripts/ci/repo-governance-check.sh
      ;;
    web-core)
      scripts/ci/web-core-check.sh
      ;;
    web-targeted)
      scripts/ci/web-targeted-check.sh
      ;;
    web-full|web)
      scripts/ci/web-full-check.sh
      ;;
    protocol)
      scripts/ci/protocol-check.sh
      ;;
    mcp-package)
      scripts/ci/hushh-mcp-package-check.sh
      ;;
    integration)
      scripts/ci/integration-check.sh
      ;;
    smoke)
      scripts/ci/main-post-merge-smoke.sh
      ;;
    advisory)
      scripts/ci/docs-parity-check.sh
      scripts/ci/subtree-sync-check.sh
      scripts/ci/github-security-alerts.sh
      scripts/ci/verify-production-environment-governance.sh
      ./bin/hushh codex audit --text
      ;;
    *)
      echo "Unknown stage: $stage" >&2
      usage
      exit 1
      ;;
  esac
}

case "$STAGE" in
  secret|governance|web-core|web-targeted|web-full|web|protocol|mcp-package|integration|smoke|advisory)
    run_stage "$STAGE"
    ;;
  all)
    echo "== CI Parity (Local) =="
    echo "Running blocking CI stages: secret, governance, web-full, protocol, mcp-package, integration."
    run_stage secret
    run_stage governance
    run_stage web-full
    run_stage protocol
    run_stage mcp-package
    run_stage integration
    if [ "${INCLUDE_ADVISORY_CHECKS:-0}" = "1" ]; then
      echo "Including advisory checks (docs parity + subtree sync + Codex OS audit)."
      run_stage advisory
    else
      echo "Skipping advisory checks. Set INCLUDE_ADVISORY_CHECKS=1 to include."
    fi
    echo "✅ Local CI parity checks passed."
    ;;
  *)
    echo "Unknown stage: $STAGE" >&2
    usage
    exit 1
    ;;
esac
