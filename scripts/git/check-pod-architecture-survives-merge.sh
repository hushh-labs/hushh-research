#!/usr/bin/env bash
# scripts/git/check-pod-architecture-survives-merge.sh
#
# Refuse a merge that deletes the per-person pod architecture.
#
# WHY THIS BLOCKS WHEN THE SIBLING CHECK ONLY WARNS
# -------------------------------------------------
# scripts/git/check-merge-regression.sh is advisory because it is a heuristic:
# it guesses at whether landed work survived, and it has a demonstrated
# false-positive rate, so failing a commit on it would cost more than it saves.
#
# This one is not a heuristic. It asks a counted question with an exact answer:
# does `deploy/backend.cloudbuild.yaml` still contain the tokens that build the
# per-user pod image? `main` contains none of them; this branch contains all of
# them. A merge that takes `main`'s side of that one file drops the count to
# zero, and there is no reading of that which is a false positive.
#
# It has now happened twice.
#
#     token                     branch   main
#     _BUILD_POD_IMAGE               5      0
#     Dockerfile.pod                 3      0
#     consent-protocol-pod           4      0
#
#   2026-08-12  Found while resolving a sync by hand, before it landed.
#   2026-09-11  Landed. A clean merge of `origin/main` deleted the pod image
#               build entirely and the branch kept a green diff. The suite went
#               to 29 failures and 30 errors; the architecture guard named the
#               loss, but only after the merge commit existed and only when
#               somebody ran the full suite. This hook is that guard moved
#               earlier, to the moment the loss is still free to undo.
#
# The authority for WHICH markers matter is the test, not this file:
# consent-protocol/tests/test_pod_architecture_is_authoritative.py. This script
# runs it. Adding a marker there arms it here with no change to this file.
#
# Scope: a merge in progress only. `git rebase` creates no merge commit and
# never reaches the hook that calls this, which is a stated gap, not an
# oversight.
#
# HOW IT KNOWS A MERGE IS UNDERWAY, and why not MERGE_HEAD. Measured on git
# 2.50.1: during `pre-merge-commit` for a CLEAN merge, MERGE_HEAD does not
# exist. A script that gates on it therefore exits silently in exactly the
# case that matters, since a clean merge is how the architecture was lost.
# The hook running at all IS the signal, so the hook passes --in-merge and
# this only self-detects when somebody runs it by hand.

set -uo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
GUARD="consent-protocol/tests/test_pod_architecture_is_authoritative.py"

# A linked worktree keeps .git as a FILE, so "$REPO_ROOT/.git/MERGE_HEAD" never
# resolves there and the check would silently pass. Ask git for the path.
if [ "${1:-}" != "--in-merge" ]; then
  MERGE_HEAD_PATH=$(git rev-parse --git-path MERGE_HEAD 2>/dev/null) || exit 0
  [ -f "$MERGE_HEAD_PATH" ] || exit 0
fi
[ -f "$REPO_ROOT/$GUARD" ] || exit 0

if ! command -v uv >/dev/null 2>&1; then
  echo "[pod-architecture] uv not found; cannot verify the merge. Run the guard by hand:" >&2
  echo "    cd consent-protocol && uv run pytest ${GUARD#consent-protocol/} -q" >&2
  exit 0
fi

OUTPUT=$(cd "$REPO_ROOT/consent-protocol" && uv run pytest "${GUARD#consent-protocol/}" -q 2>&1)
STATUS=$?
[ "$STATUS" -eq 0 ] && exit 0

cat >&2 <<'BANNER'

  ARCHITECTURAL REGRESSION IN THIS MERGE. The commit is refused.

  This branch carries the modular per-person pod deployment and `main` does
  not. Something in this merge took `main`'s side of a file that holds it.
  Git resolved the text correctly and deleted the architecture doing it.

  Resolve by architectural intent, not by recency:

    1. Keep THIS branch's side on every pod-deployment surface.
    2. Port genuinely new `main` content on top of that side.
    3. Re-run the guard until it passes, then finish the merge.

  The named losses follow. Full procedure: CLAUDE.md, "Branch synchronization".

BANNER
NAMED=$(printf '%s\n' "$OUTPUT" | grep -E "ARCHITECTURAL REGRESSION|FAILED|is missing entirely")
if [ -n "$NAMED" ]; then
  printf '%s\n' "$NAMED" >&2
else
  # The guard refused but said nothing recognisable, which happens when the
  # nested run cannot start (no interpreter, a nested pytest, a broken venv).
  # Never swallow it: a refusal with no reason is the thing that gets
  # overridden. Show the tail verbatim instead.
  echo "  The guard refused but its output was not in the expected form." >&2
  echo "  Raw tail follows; re-run it directly to see the whole thing:" >&2
  echo "      cd consent-protocol && uv run pytest ${GUARD#consent-protocol/} -q" >&2
  printf '%s\n' "$OUTPUT" | tail -20 >&2
fi
echo "" >&2
echo "  Override for one merge only, and only if you meant it:" >&2
echo "      HUSHH_ALLOW_POD_ARCHITECTURE_LOSS=1 git commit" >&2
exit 1
