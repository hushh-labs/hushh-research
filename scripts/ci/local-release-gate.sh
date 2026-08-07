#!/usr/bin/env bash
# One command that runs every CI check GitHub Actions would run, and emits a
# signed-off verdict the deploy driver can consume.
#
# WHY THIS EXISTS: when runners are unavailable, `CI Status Gate` and
# `Main Post-Merge Smoke Gate` never report, and every deploy lane refuses the
# SHA. The checks themselves do not need GitHub -- scripts/ci/orchestrate.sh is
# the canonical stage runner and is already documented as being for "GitHub
# Actions and local CI wrappers". This is that wrapper, plus the three
# PR-shaped checks orchestrate.sh omits, plus a machine-readable report.
#
# HOW IT DIFFERS FROM `orchestrate.sh all`, and why the difference matters:
#   - orchestrate.sh stops at the first failing stage (set -e). This runs every
#     stage and reports all failures at once, because when you are trying to
#     ship you want the whole list, not a fresh one every 20 minutes.
#   - `all` omits `smoke`, which is the stage the deploy gate actually names.
#   - `all` omits dco / pr-base-policy / main-freshness, which CI Status Gate
#     lists in its needs.
#
# THE REPORT IS THE POINT. It writes a JSON verdict keyed to the exact SHA, and
# scripts/ops/cloudbuild_release.sh --skip-ci-check refuses to deploy without
# one. That keeps the fallback lane evidence-based: the green check is replaced
# by a real local run, not by a waiver.
#
# Usage:
#   scripts/ci/local-release-gate.sh                  # full gate
#   scripts/ci/local-release-gate.sh --fast           # skip web/protocol/mcp lanes
#   scripts/ci/local-release-gate.sh --stage smoke    # one stage
#   scripts/ci/local-release-gate.sh --list           # show stage -> check mapping
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

MODE="full"
ONLY_STAGE=""
REPORT_DIR="${HUSHH_GATE_REPORT_DIR:-${TMPDIR:-/tmp}}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast) MODE="fast"; shift ;;
    --stage) ONLY_STAGE="$2"; shift 2 ;;
    --list) MODE="list"; shift ;;
    -h|--help) sed -n '1,32p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Toolchain preflight. CI runs Python 3.13; a bare `python3` on macOS is often
# the system 3.9, which lacks tomllib and PyYAML. The governance stage then dies
# with "No module named 'tomllib'" -- a failure that reads exactly like a code
# problem and is not one. Resolve a correct interpreter up front and put it
# first on PATH so every child script agrees. consent-protocol/.venv is
# preferred because it is the interpreter CI itself provisions, and it carries
# the deps (PyYAML) that a bare 3.13 install does not. It also brings the
# repo-pinned ruff, matching the pre-commit hook.
resolve_python() {
  local candidate
  for candidate in \
    "${REPO_ROOT}/consent-protocol/.venv/bin" \
    "$(dirname "$(command -v python3.13 2>/dev/null || echo /nonexistent)")" \
    "${HOME}/.local/bin"
  do
    if [[ -x "${candidate}/python3" ]] && \
       "${candidate}/python3" -c 'import sys,tomllib,yaml; sys.exit(0 if sys.version_info>=(3,11) else 1)' 2>/dev/null; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

if PYBIN="$(resolve_python)"; then
  export PATH="${PYBIN}:${PATH}"
else
  printf '\033[0;31m[fail] No Python 3.11+ with tomllib and PyYAML found.\033[0m\n' >&2
  echo "CI runs 3.13; the system python3 here is $(python3 --version 2>&1)." >&2
  echo "Create the interpreter CI uses, then re-run:" >&2
  echo "  (cd consent-protocol && uv sync --frozen --group dev)" >&2
  exit 2
fi

# Node major must match CI too, and the failure mode when it does not is nasty
# rather than obvious. CI pins Node 24 (ci.yml NODE_VERSION). On Node 20,
# child_process.exec caps captured stdout at 8192 bytes, so packages/hushh-mcp's
# bin-config tests parse a truncated manifest and fail with
# "Unterminated string in JSON at position 8192" -- which looks like a corrupt
# manifest and is really a version skew. Refuse to report a verdict we cannot
# stand behind.
CI_NODE_MAJOR="$(grep -oE 'NODE_VERSION:[[:space:]]*"?[0-9]+' .github/workflows/ci.yml 2>/dev/null \
  | head -1 | grep -oE '[0-9]+$' || echo 24)"
node_major_of() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if command -v node >/dev/null 2>&1; then
  LOCAL_NODE_MAJOR="$(node_major_of node)"
else
  LOCAL_NODE_MAJOR=0
fi

# Find a matching Node rather than telling the operator to go fix their machine.
# nvm keeps every installed version in a predictable place, so if CI's major is
# already installed we can just use it for this run without touching the shell's
# default or the operator's other projects.
if [[ "$LOCAL_NODE_MAJOR" != "$CI_NODE_MAJOR" ]]; then
  for candidate in "${NVM_DIR:-$HOME/.nvm}/versions/node/v${CI_NODE_MAJOR}."*/bin; do
    if [[ -x "${candidate}/node" ]] && [[ "$(node_major_of "${candidate}/node")" == "$CI_NODE_MAJOR" ]]; then
      export PATH="${candidate}:${PATH}"
      LOCAL_NODE_MAJOR="$CI_NODE_MAJOR"
      printf '\033[0;90m[gate] Using Node %s from %s to match CI.\033[0m\n' \
        "$(node --version)" "$candidate"
      break
    fi
  done
fi

if [[ "$LOCAL_NODE_MAJOR" != "$CI_NODE_MAJOR" ]]; then
  # Match the whole value: ${var/0/none} would rewrite the 0 inside "20".
  if [[ "$LOCAL_NODE_MAJOR" == "0" ]]; then NODE_LABEL="not found"; else NODE_LABEL="$LOCAL_NODE_MAJOR"; fi
  printf '\033[0;31m[fail] Node major %s does not match CI (%s).\033[0m\n' \
    "$NODE_LABEL" "$CI_NODE_MAJOR" >&2
  echo "Node 20 truncates captured stdout at 8192 bytes, which makes the MCP" >&2
  echo "package tests fail on a truncated manifest rather than on real defects." >&2
  echo "A verdict from the wrong runtime is worse than no verdict." >&2
  echo "No Node ${CI_NODE_MAJOR} was found to borrow, so install it once:" >&2
  echo "  nvm install ${CI_NODE_MAJOR}     # or: fnm install ${CI_NODE_MAJOR}" >&2
  echo "The gate will then pick it up automatically; your default Node is untouched." >&2
  echo "Set GATE_ALLOW_NODE_SKEW=1 to proceed anyway (report records the skew)." >&2
  if [[ "${GATE_ALLOW_NODE_SKEW:-0}" != "1" ]]; then
    exit 2
  fi
  NODE_SKEW="true"
else
  NODE_SKEW="false"
fi

SHA="$(git rev-parse HEAD)"
BASE_REF="${GATE_BASE_REF:-main}"
BASE_SHA="$(git merge-base "origin/${BASE_REF}" HEAD 2>/dev/null || echo "")"
REPORT_PATH="${REPORT_DIR}/hushh-ci-gate-${SHA}.json"

bold()  { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
grey()  { printf '\033[0;90m%s\033[0m\n' "$*"; }

# stage | github check job it stands in for | included in --fast
STAGE_TABLE=(
  "secret|Secret Scan|yes"
  "governance|Governance|yes"
  "dco|DCO|yes"
  "pr-base-policy|PR Base Policy|yes"
  "main-freshness|Base Freshness Gate|yes"
  "web-core|Web Core (Next.js)|no"
  "web-targeted|Web Targeted Contracts|no"
  "protocol|Protocol (Python)|no"
  "mcp-package|MCP Package|no"
  "integration|Integration|yes"
  "smoke|Main Post-Merge Smoke Gate|no"
)

if [[ "$MODE" == "list" ]]; then
  bold "Stage -> GitHub check it stands in for"
  printf '%-16s %-34s %s\n' "STAGE" "GITHUB CHECK" "IN --fast"
  for row in "${STAGE_TABLE[@]}"; do
    IFS='|' read -r s c f <<<"$row"
    printf '%-16s %-34s %s\n' "$s" "$c" "$f"
  done
  bold "Never reproducible locally"
  grey "  GitHub secret-scanning / dependabot alert state beyond what \`gh\` can read."
  grey "  Anything asserting the merge commit GitHub itself would build."
  exit 0
fi

# The three PR-shaped checks orchestrate.sh has no stage for. Their scripts all
# accept the refs as arguments, so they run fine off a laptop -- they were only
# ever coupled to the workflow by how the values were sourced.
run_pr_shaped_stage() {
  case "$1" in
    dco)
      GITHUB_BASE_SHA="$BASE_SHA" GITHUB_HEAD_SHA="$SHA" \
        bash scripts/ci/check-dco-signoff.sh "$BASE_SHA" "$SHA"
      ;;
    pr-base-policy)
      python3 scripts/ci/verify-pr-base-policy.py \
        --base-ref "$BASE_REF" \
        --head-ref "$(git rev-parse --abbrev-ref HEAD)" \
        --actor "$(gh api user --jq .login 2>/dev/null || echo unknown)"
      ;;
    main-freshness)
      MAIN_SYNC_REMOTE=origin MAIN_SYNC_BRANCH="$BASE_REF" MAIN_SYNC_MODE=block \
      MAIN_SYNC_CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)" \
        sh scripts/git/check-main-sync.sh
      ;;
  esac
}

declare -a RESULTS=()
FAILED=0

run_stage() {
  local stage="$1" check="$2"
  local started ended status
  started="$(date +%s)"
  bold "▶ ${stage}  (stands in for: ${check})"

  case "$stage" in
    dco|pr-base-policy|main-freshness) run_pr_shaped_stage "$stage" ;;
    *) bash scripts/ci/orchestrate.sh "$stage" ;;
  esac
  status=$?

  ended="$(date +%s)"
  local secs=$((ended - started))
  if [[ $status -eq 0 ]]; then
    green "✔ ${stage} passed (${secs}s)"
    RESULTS+=("${stage}|${check}|passed|${secs}")
  else
    red "✘ ${stage} FAILED (${secs}s)"
    RESULTS+=("${stage}|${check}|failed|${secs}")
    FAILED=1
  fi
  # A stage that fails in ~1s never reached real work -- it died on argument
  # parsing or a missing tool. Say so, because "failed" and "never ran" are
  # different problems and only one of them is about the code.
  if [[ $status -ne 0 && $secs -lt 3 ]]; then
    grey "   (failed in ${secs}s -- suspect setup/arguments, not the code under test)"
  fi
}

bold "Local release gate"
echo "SHA:      $SHA"
echo "Base:     ${BASE_REF} (merge-base ${BASE_SHA:0:12})"
echo "Mode:     $MODE${ONLY_STAGE:+ (stage=$ONLY_STAGE)}"

for row in "${STAGE_TABLE[@]}"; do
  IFS='|' read -r stage check in_fast <<<"$row"
  if [[ -n "$ONLY_STAGE" && "$ONLY_STAGE" != "$stage" ]]; then continue; fi
  if [[ -z "$ONLY_STAGE" && "$MODE" == "fast" && "$in_fast" != "yes" ]]; then
    RESULTS+=("${stage}|${check}|skipped|0")
    continue
  fi
  run_stage "$stage" "$check"
done

bold "Summary"
printf '%-16s %-34s %-9s %s\n' "STAGE" "GITHUB CHECK" "RESULT" "TIME"
for row in "${RESULTS[@]}"; do
  IFS='|' read -r s c r t <<<"$row"
  printf '%-16s %-34s %-9s %ss\n' "$s" "$c" "$r" "$t"
done

# A partial run must never be recorded as a full verdict -- the deploy driver
# reads `complete` to decide whether this report can stand in for CI.
COMPLETE=true
[[ "$MODE" == "fast" || -n "$ONLY_STAGE" ]] && COMPLETE=false
# A run on a mismatched Node cannot authorize a deploy either, even if every
# stage happened to pass -- the toolchain that produced the verdict was not CI's.
[[ "$NODE_SKEW" == "true" ]] && COMPLETE=false

SHA="$SHA" BASE_SHA="$BASE_SHA" MODE="$MODE" COMPLETE="$COMPLETE" \
NODE_SKEW="$NODE_SKEW" CI_NODE_MAJOR="$CI_NODE_MAJOR" LOCAL_NODE_MAJOR="$LOCAL_NODE_MAJOR" \
FAILED="$FAILED" REPORT_PATH="$REPORT_PATH" RESULT_ROWS="$(printf '%s\n' "${RESULTS[@]}")" \
python3 - <<'PY'
import json, os, subprocess
from pathlib import Path

rows = []
for line in os.environ["RESULT_ROWS"].splitlines():
    if not line.strip():
        continue
    stage, check, result, secs = line.split("|")
    rows.append({"stage": stage, "github_check": check, "result": result,
                 "duration_seconds": int(secs)})

generated_at = subprocess.run(
    ["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"], capture_output=True, text=True
).stdout.strip()

payload = {
    "sha": os.environ["SHA"],
    "base_sha": os.environ["BASE_SHA"],
    "mode": os.environ["MODE"],
    "complete": os.environ["COMPLETE"] == "true",
    "verdict": "failed" if os.environ["FAILED"] == "1" else "passed",
    "generated_at": generated_at,
    "generated_by": "scripts/ci/local-release-gate.sh",
    "toolchain": {
        "ci_node_major": os.environ["CI_NODE_MAJOR"],
        "local_node_major": os.environ["LOCAL_NODE_MAJOR"],
        "node_skew": os.environ["NODE_SKEW"] == "true",
    },
    "stages": rows,
    "not_covered": [
        "GitHub secret-scanning and dependabot alert state beyond what `gh` can read",
        "the merge commit GitHub itself would construct and build",
    ],
}
path = Path(os.environ["REPORT_PATH"])
path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
print(f"\nReport: {path}")
PY

if [[ $FAILED -ne 0 ]]; then
  red "Gate FAILED. Fix the stages above before deploying."
  exit 1
fi
if [[ "$COMPLETE" != "true" ]]; then
  grey "Partial run recorded. A deploy needs a full run (no --fast, no --stage)."
  exit 0
fi
green "Gate PASSED for ${SHA}."
echo "scripts/ops/cloudbuild_release.sh will accept this report with --skip-ci-check."
