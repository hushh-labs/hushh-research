#!/usr/bin/env bash
# scripts/git/check-merge-regression.sh
#
# Detects the specific failure that motivated this script (2026-08-19):
# a branch syncs `origin/main` in, a conflict gets resolved by hand, and the
# resolution silently keeps the STALE side of a hunk instead of folding in
# the fix that had already landed on main. `check-main-sync.sh` in block
# mode proves a branch CONTAINS main's commits (bounded mode, used on PRs
# into main, proves less); it says nothing about whether resolving
# those commits' conflicts actually preserved their content. This script
# checks the content.
#
# Method: for every file that changed between BASE (the old fork point) and
# UPSTREAM (main at merge time), collect UPSTREAM's non-trivial ADDED lines
# and DELETED lines separately, then check both directions against the
# resolved result: added lines that are now missing, and deleted lines that
# are still present ("resurrected"). A fix that is mostly "stop doing X" only
# shows up in the second check — checking additions alone missed exactly that
# shape of fix in testing. Either signal flags the file, with the commit(s)
# that made the change, so the reviewer can tell "superseded on purpose" from
# "silently reverted" in seconds.
#
# This is a content heuristic, not a semantic proof. It WILL flag legitimate
# supersessions (a later commit intentionally replaced main's lines). Read
# the flagged diff before deciding; that is the job the check exists to make
# fast, not to replace.
#
# Usage:
#   check-merge-regression.sh <base-ref> <upstream-ref> [target-ref|--worktree]
#
#   target-ref   defaults to HEAD. Pass --worktree to read the checked-out
#                files on disk instead (for an in-progress, not-yet-committed
#                conflict resolution).
#
# Env:
#   MERGE_REGRESSION_MODE          block (default) | warn
#   MERGE_REGRESSION_MIN_LINE_LEN  ignore added lines shorter than this many
#                                  significant characters (default 12)
#   MERGE_REGRESSION_THRESHOLD_PCT flag a file once this % of its upstream
#                                  added lines are missing (default 40)
#   MERGE_REGRESSION_EXCLUDE       extra space-separated grep -E pattern to
#                                  exclude paths, appended to the built-in
#                                  generated/lockfile exclusions
set -euo pipefail

BASE="${1:?usage: check-merge-regression.sh <base-ref> <upstream-ref> [target-ref|--worktree]}"
UPSTREAM="${2:?usage: check-merge-regression.sh <base-ref> <upstream-ref> [target-ref|--worktree]}"
TARGET="${3:-HEAD}"

MODE="${MERGE_REGRESSION_MODE:-warn}"
MIN_LEN="${MERGE_REGRESSION_MIN_LINE_LEN:-12}"
# 30, not 40: re-running the actual 2026-08-19 incident through this script
# after fixing the hook-wiring bugs scored 33% -- just under a 40% default,
# a real miss on the textbook case this tool exists for. 30 catches it while
# staying clean on every confirmed-benign case tested (a shared test-list
# line, a repeated boilerplate signature). Still just a threshold on a text
# heuristic -- see the skill for the false-negative classes no threshold
# value can fix (MIN_LEN, the exclude list, reformatting, cross-file breaks).
THRESHOLD="${MERGE_REGRESSION_THRESHOLD_PCT:-30}"

# Generated/derived files churn on every regen and are covered by their own
# generation-check gates elsewhere in CI; they are pure noise here.
EXCLUDE_RE='\.generated\.json$|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$|/contracts/'
if [ -n "${MERGE_REGRESSION_EXCLUDE:-}" ]; then
  EXCLUDE_RE="${EXCLUDE_RE}|${MERGE_REGRESSION_EXCLUDE}"
fi

USE_WORKTREE=0
if [ "$TARGET" = "--worktree" ]; then
  USE_WORKTREE=1
fi

read_target_file() {
  # $1 = path. Prints file content or nothing if the file no longer exists.
  if [ "$USE_WORKTREE" -eq 1 ]; then
    [ -f "$1" ] && cat "$1"
  else
    git show "${TARGET}:$1" 2>/dev/null || true
  fi
}


CHANGED_FILES="$(git diff --name-only --diff-filter=M "$BASE" "$UPSTREAM" | grep -Ev "$EXCLUDE_RE" || true)"

# Optional narrowing to the files a specific diff range touches. Used by the
# CI orchestrator's wide-window pass: over a 7- or 14-day window main modifies
# hundreds of files, but a PR can only have dropped content from files the PR
# itself touches. Intersecting the two makes the wide pass both fast and
# quiet — every file outside the PR's own diff is, by construction, unchanged
# by it and can only produce noise.
if [ -n "${MERGE_REGRESSION_LIMIT_TO:-}" ] && [ -n "$CHANGED_FILES" ]; then
  LIMIT_FILES="$(git diff --name-only $MERGE_REGRESSION_LIMIT_TO 2>/dev/null || true)"
  if [ -z "$LIMIT_FILES" ]; then
    CHANGED_FILES=""
  else
    CHANGED_FILES="$(comm -12 <(printf '%s\n' "$CHANGED_FILES" | sort -u) <(printf '%s\n' "$LIMIT_FILES" | sort -u))"
  fi
fi

if [ -z "$CHANGED_FILES" ]; then
  echo "[merge-regression] No modified-file overlap between $BASE and $UPSTREAM to check."
  exit 0
fi

TMP_REPORT="$(mktemp)"
TMP_SCAN="$(mktemp -d)"
# Dump whatever was collected if this script dies for any reason other than
# its own two designed exits (0 clean, 1 flagged-in-block-mode). The report is
# built into a temp file and only printed at the end, so an unexpected death
# mid-scan used to destroy the finding AND — under `continue-on-error` in CI —
# look exactly like a pass. A silent detector is worse than no detector.
trap 'rc=$?
      if [ "$rc" -ne 0 ] && [ "$rc" -ne 1 ]; then
        echo "[merge-regression] INTERNAL ERROR — exited $rc mid-scan. Partial findings:" >&2
        cat "$TMP_REPORT" >&2 2>/dev/null || true
        echo "[merge-regression] Treat this run as INCONCLUSIVE, not clean." >&2
      fi
      rm -f "$TMP_REPORT"
      rm -rf "$TMP_SCAN"' EXIT

FLAGGED=0
CHECKED=0

while IFS= read -r f; do
  [ -z "$f" ] && continue
  CHECKED=$((CHECKED + 1))

  target_content="$(read_target_file "$f")"

  # A file the branch never touched inherits UPSTREAM's content byte for
  # byte — trivially safe, and the one case the line-matching heuristic
  # below cannot be trusted on: UPSTREAM's own diff can legitimately reuse a
  # removed line's exact text elsewhere in the same file (a duplicated
  # pattern, a renamed variable that collides with old text), which reads as
  # a false "resurrection" even though the resolved file IS upstream.
  upstream_content="$(git show "${UPSTREAM}:$f" 2>/dev/null || true)"
  if [ "$target_content" = "$upstream_content" ]; then
    continue
  fi
  base_content="$(git show "${BASE}:$f" 2>/dev/null || true)"

  # One literal scan per file, instead of thousands of grep processes.
  # Thresholds, unique-line rules and both signal directions are unchanged.
  printf '%s\n' "$base_content" > "$TMP_SCAN/base"
  printf '%s\n' "$upstream_content" > "$TMP_SCAN/upstream"
  printf '%s\n' "$target_content" > "$TMP_SCAN/target"
  git diff "$BASE" "$UPSTREAM" -- "$f" > "$TMP_SCAN/diff"
  python3 "$(dirname "$0")/merge_line_match.py" "$TMP_SCAN" "$MIN_LEN" > "$TMP_SCAN/signals" || exit 2
  added_total=0
  deleted_total=0
  missing_lines=()
  resurrected_lines=()
  while IFS=$'\t' read -r kind value; do
    case "$kind" in
      added) added_total="$value" ;;
      deleted) deleted_total="$value" ;;
      missing) missing_lines+=("$value") ;;
      restored) resurrected_lines+=("$value") ;;
    esac
  done < "$TMP_SCAN/signals"
  missing="${#missing_lines[@]}"
  resurrected="${#resurrected_lines[@]}"
  added_pct=0
  [ "$added_total" -gt 0 ] && added_pct=$(( missing * 100 / added_total ))
  deleted_pct=0
  [ "$deleted_total" -gt 0 ] && deleted_pct=$(( resurrected * 100 / deleted_total ))

  if [ "$added_pct" -ge "$THRESHOLD" ] || [ "$deleted_pct" -ge "$THRESHOLD" ]; then
    FLAGGED=1
    {
      echo ""
      echo "FILE: $f"
      echo "  Landed on $UPSTREAM via:"
      # `git log -n 5`, never `git log | head -5`. Under `set -o pipefail`,
      # head closing the pipe early sends git SIGPIPE, the pipeline reports
      # 141, and `set -e` kills the script — at the FIRST flagged file whose
      # history is longer than five commits, before anything is printed. That
      # made every real finding invisible while the check still looked green.
      git log -n 5 --format='    %h %an: %s' "$BASE".."$UPSTREAM" -- "$f"
      if [ "$added_pct" -ge "$THRESHOLD" ]; then
        echo "  ${missing}/${added_total} of upstream's added lines are MISSING (${added_pct}%):"
        for m in "${missing_lines[@]:0:8}"; do
          printf '    - %s\n' "$m"
        done
        [ "${#missing_lines[@]}" -gt 8 ] && echo "    ... and $(( ${#missing_lines[@]} - 8 )) more"
      fi
      if [ "$deleted_pct" -ge "$THRESHOLD" ]; then
        echo "  ${resurrected}/${deleted_total} lines upstream DELETED are still present (${deleted_pct}%):"
        for m in "${resurrected_lines[@]:0:8}"; do
          printf '    - %s\n' "$m"
        done
        [ "${#resurrected_lines[@]}" -gt 8 ] && echo "    ... and $(( ${#resurrected_lines[@]} - 8 )) more"
      fi
    } >> "$TMP_REPORT"
  fi
done <<< "$CHANGED_FILES"

if [ "$FLAGGED" -eq 1 ]; then
  echo "============================================================"
  echo "[merge-regression] POSSIBLE REGRESSION — resolved content is missing"
  echo "lines that $UPSTREAM already had for this file since $BASE."
  echo "Checked $CHECKED file(s); flagged the ones below."
  echo "============================================================"
  cat "$TMP_REPORT"
  echo ""
  echo "If this is intentional (the fix was superseded by newer work), say so"
  echo "in the commit message. Otherwise re-resolve, keeping BOTH sides' intent"
  echo "— see the sync-main skill's conflict rule, or scripts/git/sync-main.sh."
  if [ "$MODE" = "block" ]; then
    exit 1
  fi
  exit 0
fi

echo "[merge-regression] OK — checked $CHECKED file(s) changed between $BASE and $UPSTREAM; no content dropped from $TARGET."
exit 0
