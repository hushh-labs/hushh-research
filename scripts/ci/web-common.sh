#!/usr/bin/env bash

web_ci_repo_root() {
  git rev-parse --show-toplevel
}

web_ci_dir() {
  printf '%s/hushh-webapp\n' "$(web_ci_repo_root)"
}

web_ci_preflight() {
  local web_dir
  web_dir="$(web_ci_dir)"
  local node_version_min="${NODE_VERSION_MIN:-20}"

  cd "$web_dir"

  node --version
  node -e "const v = process.version.match(/^v(\d+)\./); if (!v || parseInt(v[1], 10) < ${node_version_min}) throw new Error('Node.js ${node_version_min}+ required')"

  test -f package-lock.json || (echo "❌ ERROR: package-lock.json not found. Run 'npm install' to generate it." && exit 1)
  node -e "JSON.parse(require('fs').readFileSync('package-lock.json'))" || (echo "❌ ERROR: package-lock.json is not valid JSON" && exit 1)
  test -f next.config.ts || (echo "❌ ERROR: next.config.ts not found" && exit 1)

  npm --version
}

web_ci_install() {
  local web_dir
  web_dir="$(web_ci_dir)"
  cd "$web_dir"

  if [ "${WEB_CI_CLEAN_INSTALL:-0}" = "1" ]; then
    rm -rf node_modules
  fi

  npm ci --prefer-offline --no-audit --progress=false
}

web_ci_build() {
  local web_dir
  web_dir="$(web_ci_dir)"
  cd "$web_dir"

  NEXT_PUBLIC_BACKEND_URL="${NEXT_PUBLIC_BACKEND_URL:-https://api.example.com}" \
  NEXT_PUBLIC_DEVELOPER_API_URL="${NEXT_PUBLIC_DEVELOPER_API_URL:-https://api.example.com}" \
  NEXT_PUBLIC_APP_ENV="${NEXT_PUBLIC_APP_ENV:-development}" \
  NEXT_PUBLIC_FIREBASE_API_KEY="${NEXT_PUBLIC_FIREBASE_API_KEY:-test-api-key}" \
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN="${NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN:-dummy-project.firebaseapp.com}" \
  NEXT_PUBLIC_FIREBASE_PROJECT_ID="${NEXT_PUBLIC_FIREBASE_PROJECT_ID:-dummy-project}" \
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET="${NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET:-dummy-project.appspot.com}" \
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID="${NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID:-123456789}" \
  NEXT_PUBLIC_FIREBASE_APP_ID="${NEXT_PUBLIC_FIREBASE_APP_ID:-1:123456789:web:abcdef123456}" \
  npm run build
}

web_ci_changed_files() {
  local repo_root base head default_branch
  repo_root="$(web_ci_repo_root)"
  cd "$repo_root"

  if [ -n "${WEB_TARGETED_CHANGED_FILES:-}" ]; then
    printf '%s\n' "$WEB_TARGETED_CHANGED_FILES" | sed '/^[[:space:]]*$/d'
    return
  fi

  local local_changes
  local_changes="$(
    {
      git diff --name-only
      git diff --name-only --cached
    } | sed '/^[[:space:]]*$/d' | sort -u
  )"
  if [ -n "$local_changes" ]; then
    printf '%s\n' "$local_changes"
    return
  fi

  base="${WEB_TARGETED_BASE_SHA:-}"
  head="${WEB_TARGETED_HEAD_SHA:-HEAD}"

  if [ -n "$base" ] && git rev-parse --verify "$base" >/dev/null 2>&1; then
    git diff --name-only "$base" "$head"
    return
  fi

  default_branch="${WEB_TARGETED_BASE_REF:-${GITHUB_BASE_REF:-main}}"
  git fetch origin "$default_branch" --quiet || true
  if git rev-parse --verify "origin/$default_branch" >/dev/null 2>&1; then
    git diff --name-only "origin/$default_branch...HEAD"
    return
  fi

  git diff --name-only HEAD~1..HEAD 2>/dev/null || true
}
