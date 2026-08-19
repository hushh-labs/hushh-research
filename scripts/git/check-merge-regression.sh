#!/usr/bin/env bash
# scripts/git/check-merge-regression.sh
#
# Detects the specific failure that motivated this script (2026-08-19):
# a branch syncs `origin/main` in, a conflict gets resolved by hand, and the
# resolution silently keeps the STALE side of a hunk instead of folding in
# the fix that had already landed on main. `check-main-sync.sh` proves a
# branch CONTAINS main's commits; it says nothing about whether resolving
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

if [ -z "$CHANGED_FILES" ]; then
  echo "[merge-regression] No modified-file overlap between $BASE and $UPSTREAM to check."
  exit 0
fi

TMP_REPORT="$(mktemp)"
trap 'rm -f "$TMP_REPORT"' EXIT

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

  # Significant lines BASE -> UPSTREAM changed for this file: strip the
  # leading '+'/'-', drop pure-comment/whitespace noise, require real length,
  # and drop lines that recur more than once in their own source file — a
  # repeated boilerplate signature (e.g. `async (id: string) => {` reused
  # across many unrelated callbacks in a large file) cannot be told apart
  # from a genuine resurrection/drop by exact-text matching alone.
  # (Built with plain read loops, not `mapfile` — this must also run under
  # macOS's stock bash 3.2, which has no mapfile/associative arrays.)
  added_lines=()
  while IFS= read -r line; do
    [ "$(grep -cF -- "$line" <<<"$upstream_content")" -eq 1 ] && added_lines+=("$line")
  done < <(
    git diff "$BASE" "$UPSTREAM" -- "$f" \
      | grep -E '^\+[^+]' \
      | sed -E 's/^\+//' \
      | sed -E 's/^[[:space:]]+//' \
      | grep -Ev '^[[:space:]]*$' \
      | grep -Ev '^(//|\*|#)' \
      | awk -v n="$MIN_LEN" 'length($0) >= n'
  )

  # Significant lines UPSTREAM deleted relative to BASE. If these are still
  # present in the resolved result, the resolution kept the side a fix was
  # written to remove — the mirror image of a dropped addition, and the
  # actual signature of the incident this script exists to catch (a fix that
  # is mostly "stop doing X" shows up here, not in added_lines).
  deleted_lines=()
  while IFS= read -r line; do
    [ "$(grep -cF -- "$line" <<<"$base_content")" -eq 1 ] && deleted_lines+=("$line")
  done < <(
    git diff "$BASE" "$UPSTREAM" -- "$f" \
      | grep -E '^-[^-]' \
      | sed -E 's/^-//' \
      | sed -E 's/^[[:space:]]+//' \
      | grep -Ev '^[[:space:]]*$' \
      | grep -Ev '^(//|\*|#)' \
      | awk -v n="$MIN_LEN" 'length($0) >= n'
  )

  [ "${#added_lines[@]}" -eq 0 ] && [ "${#deleted_lines[@]}" -eq 0 ] && continue

  missing=0
  missing_lines=()
  # `${arr[@]+"${arr[@]}"}`, not `"${arr[@]}"` — bash 3.2 (macOS stock) treats
  # expanding a zero-element array as an unbound variable under `set -u`.
  for line in "${added_lines[@]+"${added_lines[@]}"}"; do
    if [ -z "$target_content" ] || ! grep -qF -- "$line" <<<"$target_content"; then
      missing=$((missing + 1))
      missing_lines+=("$line")
    fi
  done

  resurrected=0
  resurrected_lines=()
  for line in "${deleted_lines[@]+"${deleted_lines[@]}"}"; do
    if [ -n "$target_content" ] && grep -qF -- "$line" <<<"$target_content"; then
      resurrected=$((resurrected + 1))
      resurrected_lines+=("$line")
    fi
  done

  added_total="${#added_lines[@]}"
  deleted_total="${#deleted_lines[@]}"
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
      git log --format='    %h %an: %s' "$BASE".."$UPSTREAM" -- "$f" | head -5
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
