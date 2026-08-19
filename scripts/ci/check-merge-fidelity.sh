#!/usr/bin/env bash
# scripts/ci/check-merge-fidelity.sh
#
# CI orchestrator for the "Merge Fidelity Gate" job. Runs both regression
# passes a PR needs — every internal sync-merge commit it introduces, AND
# the PR's own whole diff against its base (catches a CLEAN revert commit
# with no merge conflict at all, which introduces no merge commit and so is
# invisible to the first pass) — through check-merge-regression.sh, then
# applies the intentional-revert escape hatch before deciding pass/fail.
#
# Kept separate from check-merge-regression.sh (no PR/GitHub concept; also
# runs locally via `./bin/hushh sync`) and from scan-pr-merges-for-regression.sh
# (only knows about merge commits) — this is the one place PR metadata
# (labels, body trailer) gets read.
#
# Escape hatch: a PR flagged by either pass is not failed if BOTH of these
# are true — two independent signals, neither requiring elevated permission,
# so it can't be tripped by accident:
#   - the PR carries the label "intentional-revert"
#   - the PR body contains a line "Merge-Regression-Ack: <reason>"
# Both are read LIVE via `gh pr view` when this step actually runs, not from
# the event payload frozen at trigger time — so adding the label/trailer and
# re-running the job (no new push needed) picks them up.
#
# Usage: BASE_REF=main PR_NUMBER=1234 GITHUB_REPOSITORY=org/repo \
#          bash scripts/ci/check-merge-fidelity.sh
#
# Env:
#   MERGE_REGRESSION_MODE   block | warn (default warn) — this repo runs it
#                           in warn during the Phase 1 burn-in period.
#   BASE_REF                required, e.g. "main" or "integration/pr-train".
#   PR_NUMBER, GITHUB_REPOSITORY   required to read the escape hatch; if
#                           unset (e.g. a manual local run) the escape hatch
#                           is simply unavailable and a flag always reports.
set -uo pipefail

MODE="${MERGE_REGRESSION_MODE:-warn}"
BASE_REF="${BASE_REF:?BASE_REF is required, e.g. main}"
REPO_ROOT="$(git rev-parse --show-toplevel)"

FOUND=0

echo "== Pass 1: sync-merge commits this PR introduces =="
MERGE_REGRESSION_MODE=block bash "$REPO_ROOT/scripts/git/scan-pr-merges-for-regression.sh" "origin/${BASE_REF}" || FOUND=1

echo ""
echo "== Pass 2: this PR's whole diff against its own merge-base (catches a clean revert, no conflict needed) =="
PR_BASE="$(git merge-base HEAD "origin/${BASE_REF}")"
MERGE_REGRESSION_MODE=block bash "$REPO_ROOT/scripts/git/check-merge-regression.sh" "$PR_BASE" "origin/${BASE_REF}" HEAD || FOUND=1

if [ "$FOUND" -eq 0 ]; then
  echo ""
  echo "[merge-fidelity] OK — neither pass found dropped content."
  exit 0
fi

# Something was flagged. Check for the intentional-revert escape hatch.
ACK=""
LABELED=0
ACTOR=""
if [ -n "${PR_NUMBER:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ] && command -v gh >/dev/null 2>&1; then
  PR_JSON="$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --json body,labels,author 2>/dev/null || echo '{}')"
  LABELED="$(python3 -c '
import json, sys
d = json.loads(sys.argv[1] or "{}")
print(1 if any(l.get("name") == "intentional-revert" for l in d.get("labels", [])) else 0)
' "$PR_JSON" 2>/dev/null || echo 0)"
  ACK="$(python3 -c '
import json, re, sys
d = json.loads(sys.argv[1] or "{}")
m = re.search(r"^Merge-Regression-Ack:\s*(.+)$", d.get("body") or "", re.MULTILINE)
print(m.group(1).strip() if m else "")
' "$PR_JSON" 2>/dev/null || echo "")"
  ACTOR="$(python3 -c '
import json, sys
d = json.loads(sys.argv[1] or "{}")
print(d.get("author", {}).get("login", ""))
' "$PR_JSON" 2>/dev/null || echo "")"
fi

if [ "$LABELED" -eq 1 ] && [ -n "$ACK" ]; then
  MSG="[merge-fidelity] Declared intentional revert by @${ACTOR:-unknown}: ${ACK}"
  echo ""
  echo "$MSG"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### Merge Fidelity Gate — intentional revert declared"
      echo ""
      echo "$MSG"
    } >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 0
fi

echo ""
echo "[merge-fidelity] Flagged, and no intentional-revert escape hatch found."
echo "[merge-fidelity] To declare this on purpose: add the 'intentional-revert' label"
echo "AND a 'Merge-Regression-Ack: <reason>' line in the PR body, then re-run this job"
echo "(no new push needed — the label and body are read live when the step runs)."

if [ "$MODE" = "block" ]; then
  exit 1
fi
exit 0
