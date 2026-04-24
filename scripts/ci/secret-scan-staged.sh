#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if [ "${SKIP_SECRET_SCAN:-0}" = "1" ]; then
  echo "[secret-scan] Skipping staged secret scan because SKIP_SECRET_SCAN=1"
  exit 0
fi

TMPDIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

STAGED=0
BLOCKED_PATHS=()
while IFS= read -r -d '' path; do
  STAGED=1

  case "$path" in
    .codex-worktrees/*)
      BLOCKED_PATHS+=("$path (local Codex worktree data)")
      ;;
    .env|*/.env|.env.*|*/.env.*)
      case "$path" in
        *.example) ;;
        *)
          BLOCKED_PATHS+=("$path (real env file)")
          ;;
      esac
      ;;
    google-services.json|*/google-services.json)
      BLOCKED_PATHS+=("$path (Firebase Android config)")
      ;;
    GoogleService-Info.plist|*/GoogleService-Info.plist)
      BLOCKED_PATHS+=("$path (Firebase iOS config)")
      ;;
    service-account.json|*/service-account.json|firebase-service-account.json|*/firebase-service-account.json)
      BLOCKED_PATHS+=("$path (service account credential file)")
      ;;
    *.pem|*.p12|*.pfx|*.key|*.keystore|*.jks)
      BLOCKED_PATHS+=("$path (key or certificate material)")
      ;;
  esac

  mkdir -p "$TMPDIR/$(dirname "$path")"
  git show ":$path" >"$TMPDIR/$path"
done < <(git diff --cached --name-only --diff-filter=ACMR -z)

if [ "$STAGED" -eq 0 ]; then
  exit 0
fi

if [ "${#BLOCKED_PATHS[@]}" -gt 0 ]; then
  echo "[secret-scan] Commit blocked because staged files include protected local-secret file types:"
  printf '  - %s\n' "${BLOCKED_PATHS[@]}"
  echo "[secret-scan] Use example templates, Secret Manager, or local untracked files instead."
  exit 1
fi

if command -v gitleaks >/dev/null 2>&1; then
  CONFIG_ARGS=()
  if [ -f "$REPO_ROOT/.gitleaks.toml" ]; then
    CONFIG_ARGS+=(--config "$REPO_ROOT/.gitleaks.toml")
  fi
  echo "[secret-scan] Running gitleaks on staged content..."
  gitleaks dir --redact --no-banner --exit-code 1 "${CONFIG_ARGS[@]}" "$TMPDIR"
  exit 0
fi

echo "[secret-scan] gitleaks not found; using fallback staged pattern scan."

if rg -n --hidden \
  -e 'AIza[0-9A-Za-z_\-]{20,}' \
  -e 'sk-(proj|live|test)-[0-9A-Za-z_-]{10,}' \
  -e 'GOCSPX-[0-9A-Za-z_-]{10,}' \
  -e 'ghp_[0-9A-Za-z]{20,}' \
  -e 'github_pat_[0-9A-Za-z_]{20,}' \
  -e 'AKIA[0-9A-Z]{16}' \
  -e 'ASIA[0-9A-Z]{16}' \
  -e 'xox[baprs]-[0-9A-Za-z-]{10,}' \
  -e '-----BEGIN (RSA |EC |OPENSSH |DSA |)?PRIVATE KEY-----' \
  -e '"private_key"\s*:\s*"-----BEGIN PRIVATE KEY-----' \
  "$TMPDIR" >/tmp/hushh-staged-secret-scan.txt; then
  echo "[secret-scan] Potential secret detected in staged content:"
  cat /tmp/hushh-staged-secret-scan.txt
  rm -f /tmp/hushh-staged-secret-scan.txt
  echo "[secret-scan] Commit blocked. Move credentials to Secret Manager/env files and rotate any exposed keys."
  exit 1
fi

rm -f /tmp/hushh-staged-secret-scan.txt
