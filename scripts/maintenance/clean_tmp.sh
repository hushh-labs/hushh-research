#!/usr/bin/env bash
# tmp/ retention janitor for hushh-research.
#
# Problem it solves: skills + cron jobs (PR governance, contributor-impact,
# founder briefs, audits) write scratch + reports into tmp/ on every run and
# nothing ever cleans them, so tmp/ bloats (observed: 124M / 600+ files, ~94M
# of it >7 days stale). tmp/ is gitignored, so this only touches throwaway data.
#
# Policy:
#   1. Age-out: delete any tmp/ file older than RETENTION_DAYS (default 7).
#   2. Keep-last-N: for known dated report families, always keep the newest
#      KEEP_PER_FAMILY (default 5) even if older than the age cutoff, so the
#      latest good report survives a quiet week.
#   3. Prune: empty dirs, __pycache__, *.pyc, prunable git worktrees.
#   4. Safe: only ever operates inside <repo>/tmp. Supports --dry-run.
#
# Usage:
#   scripts/maintenance/clean_tmp.sh            # apply
#   scripts/maintenance/clean_tmp.sh --dry-run  # show what would be removed
#   RETENTION_DAYS=14 KEEP_PER_FAMILY=8 scripts/maintenance/clean_tmp.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$REPO_ROOT/tmp"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
KEEP_PER_FAMILY="${KEEP_PER_FAMILY:-5}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# Hard safety: refuse to run if TMP_DIR is not the repo's own tmp.
case "$TMP_DIR" in
  */hushh-research/tmp) : ;;
  *) echo "REFUSING: TMP_DIR='$TMP_DIR' is not <repo>/tmp" >&2; exit 2 ;;
esac
[ -d "$TMP_DIR" ] || { echo "No tmp/ dir at $TMP_DIR — nothing to do."; exit 0; }

before_size="$(du -sh "$TMP_DIR" 2>/dev/null | cut -f1)"
before_count="$(find "$TMP_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')"

# Dated report families to keep-last-N (newest survive regardless of age).
# Match by basename prefix; one glob per family.
FAMILIES=(
  "pr-governance-live-report"
  "pr-governance-refill-"
  "pr-governance-lane-"
  "contributor-impact-dashboard"
  "founder-brief"
  "autodrive-run"
  "patch-run"
  "patch-queue"
  "verify-zero"
)

protected_list="$(mktemp)"
trap 'rm -f "$protected_list"' EXIT

# Build the protected set: newest KEEP_PER_FAMILY per family (by mtime).
for fam in "${FAMILIES[@]}"; do
  # shellcheck disable=SC2010
  find "$TMP_DIR" -maxdepth 2 -type f -name "${fam}*" -print0 2>/dev/null \
    | xargs -0 ls -t 2>/dev/null \
    | head -n "$KEEP_PER_FAMILY" >> "$protected_list" || true
done

removed=0
freed_note=""

# 1+2. Age-out everything older than cutoff EXCEPT protected newest-N.
while IFS= read -r -d '' f; do
  if grep -Fxq "$f" "$protected_list"; then
    continue   # protected newest-N of a report family
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "WOULD DELETE: ${f#"$TMP_DIR"/}"
  else
    rm -f "$f"
  fi
  removed=$((removed+1))
done < <(find "$TMP_DIR" -type f -mtime "+$RETENTION_DAYS" -print0 2>/dev/null)

# 3. Prune __pycache__ + *.pyc anywhere under tmp, empty dirs, worktrees.
if [ "$DRY_RUN" = "1" ]; then
  pyc=$(find "$TMP_DIR" -type d -name __pycache__ 2>/dev/null | wc -l | tr -d ' ')
  echo "WOULD PRUNE: $pyc __pycache__ dir(s), *.pyc, empty dirs"
  echo "WOULD RUN:   git worktree prune"
else
  find "$TMP_DIR" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
  find "$TMP_DIR" -type f -name '*.pyc' -delete 2>/dev/null || true
  find "$TMP_DIR" -mindepth 1 -type d -empty -delete 2>/dev/null || true
  git -C "$REPO_ROOT" worktree prune 2>/dev/null || true
fi

after_size="$(du -sh "$TMP_DIR" 2>/dev/null | cut -f1)"
after_count="$(find "$TMP_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')"

if [ "$DRY_RUN" = "1" ]; then
  echo "--- DRY RUN — nothing deleted. $removed file(s) would be removed. ---"
else
  echo "tmp janitor: removed $removed file(s). Size ${before_size:-?} -> ${after_size:-?}, files ${before_count} -> ${after_count}. (retention=${RETENTION_DAYS}d, keep-per-family=${KEEP_PER_FAMILY})"
fi
