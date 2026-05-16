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

COMMIT_RANGE="$(resolve_range "$@")"
mapfile -t COMMITS < <(git rev-list --no-merges "$COMMIT_RANGE")

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
