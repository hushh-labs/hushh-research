#!/usr/bin/env bash
# scripts/ci/check-merge-fidelity.sh
#
# CI orchestrator for the merge-fidelity checks. The Base Freshness Gate
# proves a PR CONTAINS main's commits as ancestors. It says nothing about
# whether the PR's content still HAS what those commits landed. Three
# different ways to lose landed work, three passes:
#
#   A. Bad conflict resolution. The branch merged main in, hit a conflict,
#      and the resolution kept the stale side. Leaves a merge commit, so
#      walking the PR's own sync-merges finds it.
#      (2026-08-19 incident.)
#
#   B. Clean revert inside the PR. A later commit on the branch simply
#      removes what main had landed. No conflict, no merge commit — pass A
#      is blind to it. Comparing the branch's fork point to the base tip and
#      asking whether the base's content survived into HEAD does find it.
#
#   C. Wide-window revert. The removal is not relative to this branch's fork
#      point at all — the branch is fresh, and the diff itself rolls back
#      work that landed days earlier. This is the shape of the 2026-08-20
#      mass revert (a60c51dfc), which reverted straight onto main's tip, so
#      both A and B see nothing. Widening the base to "main as of N days ago"
#      catches it. Narrowed to the files the PR actually touches — a file the
#      PR never opened cannot have been reverted by it.
#
# Advisory by design. Every pass is a text heuristic with a real
# false-positive rate (see the merge-regression-guard skill for the known
# shapes). It reports; a human decides. What it must never do is stay quiet
# when it failed to look — see INCONCLUSIVE below.
#
# Escape hatch for a deliberate revert (rolling back a bad feature on purpose
# is legitimate): put the label `intentional-revert` on the PR AND a
# `Merge-Regression-Ack: <reason>` line in the PR body. Both are required
# together; neither needs elevated permission. They are read LIVE here, so
# adding them and re-running the job clears the flag with no new push.
#
# Env:
#   MERGE_FIDELITY_BASE_REF     base to compare against (default origin/main)
#   MERGE_FIDELITY_WINDOW_DAYS  pass C look-back window (default 14)
#   MERGE_REGRESSION_MODE       warn (default) | block — governs exit code
#   MERGE_FIDELITY_PR_NUMBER    PR number, for the escape-hatch lookup
#   MERGE_FIDELITY_PASS_TIMEOUT seconds per pass before it is called
#                               INCONCLUSIVE (default 600)
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
BASE_REF="${MERGE_FIDELITY_BASE_REF:-origin/main}"
WINDOW_DAYS="${MERGE_FIDELITY_WINDOW_DAYS:-14}"
MODE="${MERGE_REGRESSION_MODE:-warn}"
PR_NUMBER="${MERGE_FIDELITY_PR_NUMBER:-}"
PASS_TIMEOUT="${MERGE_FIDELITY_PASS_TIMEOUT:-600}"

DETECTOR="$REPO_ROOT/scripts/git/check-merge-regression.sh"
MERGE_SCAN="$REPO_ROOT/scripts/git/scan-pr-merges-for-regression.sh"

FLAGGED=0
INCONCLUSIVE=0

emit() {
  printf '%s\n' "$*"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$*" >>"$GITHUB_STEP_SUMMARY"
  fi
}

# Runs one pass and classifies its exit code. 0 = clean, 1 = findings,
# anything else = the pass itself broke. That third case is the one that
# matters most: the detector used to die on a SIGPIPE at its first finding
# and print nothing, which under `continue-on-error` was indistinguishable
# from a pass. A check that cannot report is not a check that passed.
run_pass() {
  local title="$1"; shift
  local out rc
  echo ""
  echo "=============================================================="
  echo "PASS: $title"
  echo "=============================================================="
  # Bounded, because the detector is O(changed lines) and a very large revert
  # PR can run for many minutes. Without this the job's own timeout would kill
  # it, and `continue-on-error` would render that as a green check — the exact
  # silent-pass failure this script exists to refuse.
  if command -v timeout >/dev/null 2>&1; then
    out="$(timeout "$PASS_TIMEOUT" "$@" 2>&1)"
  else
    out="$("$@" 2>&1)"
  fi
  rc=$?
  printf '%s\n' "$out"
  case "$rc" in
    0) echo "[merge-fidelity] $title: clean." ;;
    1) FLAGGED=1; echo "[merge-fidelity] $title: FINDINGS above." ;;
    124)
      INCONCLUSIVE=1
      echo "[merge-fidelity] $title: INCONCLUSIVE — hit the ${PASS_TIMEOUT}s budget before finishing."
      echo "[merge-fidelity] This PR is too large for the pass to complete. Check the revert-shaped"
      echo "[merge-fidelity] parts of its diff by hand, or re-run with MERGE_FIDELITY_PASS_TIMEOUT raised."
      ;;
    *)
      INCONCLUSIVE=1
      echo "[merge-fidelity] $title: INCONCLUSIVE — the check exited $rc before finishing."
      echo "[merge-fidelity] Do not read this as clean. Re-run, or check by hand."
      ;;
  esac
}

if [ ! -x "$DETECTOR" ] || [ ! -x "$MERGE_SCAN" ]; then
  echo "[merge-fidelity] Detector scripts missing or not executable — nothing checked."
  exit 1
fi

git fetch origin --quiet 2>/dev/null || true

BASE_SHA="$(git rev-parse "$BASE_REF" 2>/dev/null || true)"
if [ -z "$BASE_SHA" ]; then
  echo "[merge-fidelity] Could not resolve $BASE_REF — nothing checked."
  exit 1
fi

# ---- Pass A: this PR's own sync-merges -------------------------------------
run_pass "A · conflict resolutions in this PR's sync merges" \
  env MERGE_REGRESSION_MODE=block bash "$MERGE_SCAN" "$BASE_REF"

# Passes B and C both ask "the base has this content — does HEAD still?". That
# question only means "the PR dropped it" if HEAD already contains the base.
# On a branch that is merely BEHIND, every commit the base gained since the
# fork point answers "missing" and the check turns into pure noise — a branch
# forked an hour ago flags every file main touched in that hour. Being behind
# is the Base Freshness Gate's job, and that gate BLOCKS, so it is the
# authority on it; there is nothing for this advisory check to add. Skip.
if git merge-base --is-ancestor "$BASE_SHA" HEAD 2>/dev/null; then
  BASE_IN_HEAD=1
else
  BASE_IN_HEAD=0
  echo ""
  echo "[merge-fidelity] PASSES B and C skipped — HEAD does not contain $BASE_REF's tip"
  echo "                 (${BASE_SHA:0:9}). This branch is behind its base, which the Base"
  echo "                 Freshness Gate already blocks on. Sync the branch and re-run;"
  echo "                 asking whether the base's content survived into a branch that"
  echo "                 never received it only produces false findings."
fi

# ---- Pass B: fork point -> base tip, did it survive into HEAD? -------------
FORK_POINT="$(git merge-base HEAD "$BASE_SHA" 2>/dev/null || true)"
if [ "$BASE_IN_HEAD" -eq 0 ]; then
  : # already explained above
elif [ -z "$FORK_POINT" ] || [ "$FORK_POINT" = "$BASE_SHA" ]; then
  echo ""
  echo "[merge-fidelity] PASS B skipped — branch forks at $BASE_REF's tip, so there is"
  echo "                 no window between the fork point and the base to lose anything in."
else
  run_pass "B · content landed between this branch's fork point and $BASE_REF" \
    env MERGE_REGRESSION_MODE=block bash "$DETECTOR" "$FORK_POINT" "$BASE_SHA" HEAD
fi

# ---- Pass C: wide window, narrowed to the files this PR touches ------------
WINDOW_SHA="$(git rev-list -1 --before="${WINDOW_DAYS} days ago" "$BASE_SHA" 2>/dev/null || true)"
if [ "$BASE_IN_HEAD" -eq 0 ]; then
  : # already explained above
elif [ -z "$WINDOW_SHA" ] || [ "$WINDOW_SHA" = "$BASE_SHA" ]; then
  echo ""
  echo "[merge-fidelity] PASS C skipped — no commit on $BASE_REF older than ${WINDOW_DAYS} days."
else
  echo ""
  echo "[merge-fidelity] PASS C window: $BASE_REF as of ${WINDOW_DAYS} days ago = ${WINDOW_SHA:0:9}"
  run_pass "C · content landed on $BASE_REF in the last ${WINDOW_DAYS} days, in files this PR touches" \
    env MERGE_REGRESSION_MODE=block \
        MERGE_REGRESSION_LIMIT_TO="${BASE_SHA}...HEAD" \
        bash "$DETECTOR" "$WINDOW_SHA" "$BASE_SHA" HEAD
fi

# ---- Verdict ---------------------------------------------------------------
echo ""
if [ "$FLAGGED" -eq 0 ] && [ "$INCONCLUSIVE" -eq 0 ]; then
  emit "### Merge fidelity: clean"
  emit "No landed content appears to have been dropped by this PR."
  exit 0
fi

if [ "$INCONCLUSIVE" -eq 1 ] && [ "$FLAGGED" -eq 0 ]; then
  emit "### Merge fidelity: INCONCLUSIVE"
  emit "A pass exited before finishing. This is **not** a pass — see the job log."
  [ "$MODE" = "block" ] && exit 1
  exit 0
fi

# Findings. Check the escape hatch before deciding what to say about them.
ACK_LABEL=0
ACK_REASON=""
if [ -n "$PR_NUMBER" ] && command -v gh >/dev/null 2>&1; then
  PR_JSON="$(gh pr view "$PR_NUMBER" --json labels,body 2>/dev/null || true)"
  if [ -n "$PR_JSON" ]; then
    # Read live, not from the trigger-time event payload: adding the label and
    # the ack line then re-running this job must clear the flag without a push.
    if printf '%s' "$PR_JSON" | python3 -c 'import json,sys
d=json.load(sys.stdin)
sys.exit(0 if any(l.get("name")=="intentional-revert" for l in (d.get("labels") or [])) else 1)' 2>/dev/null; then
      ACK_LABEL=1
    fi
    ACK_REASON="$(printf '%s' "$PR_JSON" \
      | python3 -c 'import json,sys,re
d=json.load(sys.stdin)
m=re.search(r"^Merge-Regression-Ack:[ \t]*(.+)$", d.get("body") or "", re.M)
print(m.group(1).strip() if m else "")' 2>/dev/null)"
  fi
fi

if [ "$ACK_LABEL" -eq 1 ] && [ -n "$ACK_REASON" ]; then
  emit "### Merge fidelity: findings acknowledged"
  emit "This PR carries the \`intentional-revert\` label and a declared reason, so the"
  emit "findings below are treated as deliberate."
  emit ""
  emit "> $ACK_REASON"
  exit 0
fi

emit "### Merge fidelity: $( [ "$FLAGGED" -eq 1 ] && echo 'possible dropped work' )"
emit "One or more passes found content that \`$BASE_REF\` already had and this PR does not."
emit "Read the job log — each finding names the file and the commits that landed it."
emit ""
emit "If the revert is deliberate, add the label \`intentional-revert\` **and** a line"
emit "\`Merge-Regression-Ack: <reason>\` to the PR body, then re-run this job. No new push needed."

if [ "$ACK_LABEL" -eq 1 ] && [ -z "$ACK_REASON" ]; then
  emit ""
  emit "_The \`intentional-revert\` label is present but the \`Merge-Regression-Ack:\` line is missing._"
fi
if [ "$ACK_LABEL" -eq 0 ] && [ -n "$ACK_REASON" ]; then
  emit ""
  emit "_A \`Merge-Regression-Ack:\` line is present but the \`intentional-revert\` label is missing._"
fi

[ "$MODE" = "block" ] && exit 1
exit 0
