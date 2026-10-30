#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

set -euo pipefail

resolve_range() {
  if [ "$#" -ge 2 ]; then
    echo "$1..$2"
    return 0
  fi

  if [ -n "${GITHUB_EVENT_NAME:-}" ] && [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ]; then
    echo "${GITHUB_EVENT_PULL_REQUEST_BASE_SHA:-${GITHUB_BASE_SHA:-}}..${GITHUB_EVENT_PULL_REQUEST_HEAD_SHA:-${GITHUB_HEAD_SHA:-${GITHUB_SHA:-HEAD}}}"
    return 0
  fi

  if [ -n "${GITHUB_BASE_SHA:-}" ] && [ -n "${GITHUB_SHA:-}" ]; then
    echo "${GITHUB_BASE_SHA}..${GITHUB_SHA}"
    return 0
  fi

  local default_branch
  default_branch="$(git remote show origin 2>/dev/null | sed -n 's/.*HEAD branch: //p' | head -n 1 || true)"
  default_branch="${default_branch:-main}"
  if git rev-parse "origin/$default_branch" >/dev/null 2>&1; then
    local merge_base
    merge_base="$(git merge-base "origin/$default_branch" HEAD)"
    echo "${merge_base}..HEAD"
    return 0
  fi

  echo "HEAD~1..HEAD"
}

history_sync_refusal() {
  echo "DCO history-sync refused: $1." >&2
  exit 2
}

history_sync_mode=0
trusted_main_sha=""
if [ "${1:-}" = "--history-sync" ]; then
  [ "$#" -eq 1 ] || history_sync_refusal "caller-supplied ranges are not accepted"
  [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ] || history_sync_refusal "a pull request event is required"
  case "${GITHUB_BASE_REF:-}" in
    dev|uat) ;;
    *) history_sync_refusal "only protected Dev or UAT pull requests use history-sync admission" ;;
  esac
  [ "${GITHUB_REPOSITORY:-}" = "hushh-labs/hushh-research" ] || history_sync_refusal "the canonical repository context is required"
  [ "${GITHUB_SERVER_URL:-}" = "https://github.com" ] || history_sync_refusal "the canonical GitHub provider context is required"
  [[ "${GITHUB_BASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || history_sync_refusal "the event base SHA is missing or invalid"
  [[ "${GITHUB_HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || history_sync_refusal "the event head SHA is missing or invalid"

  for sha in "$GITHUB_BASE_SHA" "$GITHUB_HEAD_SHA"; do
    git cat-file -e "${sha}^{commit}" 2>/dev/null || history_sync_refusal "an event commit is unavailable locally"
    resolved="$(git rev-parse --verify "${sha}^{commit}" 2>/dev/null || true)"
    [ "$resolved" = "$sha" ] || history_sync_refusal "an event SHA did not resolve to its exact commit"
  done

  command -v gh >/dev/null 2>&1 || history_sync_refusal "the read-only GitHub client is unavailable"
  [ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ] || history_sync_refusal "the read-only GitHub token is unavailable"
  if ! branch_payload="$(GH_HOST=github.com gh api repos/hushh-labs/hushh-research/branches/main 2>/dev/null)"; then
    history_sync_refusal "the protected Main branch response is unavailable"
  fi
  if ! trusted_main_sha="$(printf '%s' "$branch_payload" | python3 -c 'import json, re, sys; row=json.load(sys.stdin); sha=(row.get("commit") or {}).get("sha"); ok=isinstance(row,dict) and row.get("name")=="main" and row.get("protected") is True and isinstance(sha,str) and re.fullmatch(r"[0-9a-f]{40}",sha); sys.stdout.write(sha if ok else "")')"; then
    history_sync_refusal "the protected Main branch response is malformed"
  fi
  [ -n "$trusted_main_sha" ] || history_sync_refusal "the provider did not confirm protected Main and its exact commit"

  if ! git fetch --quiet --no-tags origin "$trusted_main_sha" >/dev/null 2>&1; then
    history_sync_refusal "the provider-confirmed Main commit could not be fetched"
  fi
  fetched_sha="$(git rev-parse --verify 'FETCH_HEAD^{commit}' 2>/dev/null || true)"
  [ "$fetched_sha" = "$trusted_main_sha" ] || history_sync_refusal "the fetched object differs from the provider-confirmed Main commit"
  git cat-file -e "${trusted_main_sha}^{commit}" 2>/dev/null || history_sync_refusal "the provider-confirmed Main commit is unavailable locally"

  COMMIT_RANGE="${GITHUB_BASE_SHA}..${GITHUB_HEAD_SHA}"
  history_sync_mode=1
else
  COMMIT_RANGE="$(resolve_range "$@")"
fi

COMMITS=()
if [ "$history_sync_mode" -eq 1 ]; then
  total_count="$(git rev-list --count --no-merges "$COMMIT_RANGE")" || history_sync_refusal "the event commit range is unavailable"
  checked_commits="$(git rev-list --no-merges "$COMMIT_RANGE" --not "$trusted_main_sha")" || history_sync_refusal "the trusted history comparison failed"
  if [ -n "$checked_commits" ]; then
    while IFS= read -r commit; do
      [ -n "$commit" ] || continue
      COMMITS[${#COMMITS[@]}]="$commit"
    done <<< "$checked_commits"
  fi
  excluded_count=$((total_count - ${#COMMITS[@]}))
  [ "$excluded_count" -ge 0 ] || history_sync_refusal "the trusted history count is inconsistent"
  echo "DCO history-sync: checking ${#COMMITS[@]} non-merge commit(s); excluding ${excluded_count} non-merge commit(s) reachable from protected Main ${trusted_main_sha}."
else
  checked_commits="$(git rev-list --no-merges "$COMMIT_RANGE")" || {
    echo "Unable to resolve DCO commit range ${COMMIT_RANGE}." >&2
    exit 2
  }
  if [ -n "$checked_commits" ]; then
    while IFS= read -r commit; do
      [ -n "$commit" ] || continue
      COMMITS[${#COMMITS[@]}]="$commit"
    done <<< "$checked_commits"
  fi
fi

if [ "${#COMMITS[@]}" -eq 0 ]; then
  echo "No non-merge commits found in range ${COMMIT_RANGE}."
  exit 0
fi

missing=0
for commit in "${COMMITS[@]}"; do
  body="$(git log -1 --format=%B "$commit")"
  if ! printf '%s\n' "$body" | grep -qi '^Signed-off-by:'; then
    echo "Missing DCO signoff on commit ${commit}: $(git log -1 --format=%s "$commit")" >&2
    missing=1
  fi
done

if [ "$missing" -ne 0 ]; then
  echo "Add signoff with: git commit --amend -s  (or git rebase --signoff ...)" >&2
  exit 1
fi

echo "DCO signoff check passed for ${#COMMITS[@]} commit(s) in ${COMMIT_RANGE}."
