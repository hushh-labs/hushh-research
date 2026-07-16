#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

node --check .codex/skills/reviewer-app-testing/scripts/reviewer-session-harness.mjs
node --check .codex/skills/reviewer-app-testing/scripts/verify-reviewer-byok-navigation.mjs
node --check .codex/skills/pkm-upgrade-rehearsal/scripts/reviewer-pkm-app-rehearsal.mjs
node .codex/skills/pkm-upgrade-rehearsal/scripts/reviewer-pkm-app-rehearsal.mjs --help >/dev/null
if PKM_REVIEWER_DECRYPTED_OUTPUT="$repo_root/AGENTS.md" \
  node .codex/skills/pkm-upgrade-rehearsal/scripts/reviewer-pkm-app-rehearsal.mjs \
  --help >/dev/null 2>&1; then
  echo "Reviewer rehearsal accepted decrypted output outside tmp/." >&2
  exit 1
fi

echo "Reviewer app skill checks passed."
