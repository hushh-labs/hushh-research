#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

node --check .codex/skills/reviewer-app-testing/scripts/reviewer-session-harness.mjs
node --check .codex/skills/reviewer-app-testing/scripts/reviewer-rehearsal-preflight.mjs
node --check .codex/skills/reviewer-app-testing/scripts/verify-reviewer-byok-navigation.mjs
node --check .codex/skills/reviewer-app-testing/scripts/verify-reviewer-agent-chat.mjs
consent-protocol/.venv/bin/python -m py_compile \
  .codex/skills/reviewer-app-testing/scripts/reconcile-reviewer-identity.py
node .codex/skills/reviewer-app-testing/scripts/reviewer-rehearsal-preflight.mjs --help >/dev/null
consent-protocol/.venv/bin/python \
  .codex/skills/reviewer-app-testing/scripts/reconcile-reviewer-identity.py \
  --help >/dev/null
if ! rg -q 'prepareReviewerRehearsal' \
  .codex/skills/reviewer-app-testing/scripts/verify-reviewer-byok-navigation.mjs; then
  echo "Reviewer browser rehearsal must run the preflight gate before Chromium." >&2
  exit 1
fi
if ! rg -q 'prepareReviewerRehearsal' \
  .codex/skills/reviewer-app-testing/scripts/verify-reviewer-agent-chat.mjs; then
  echo "Reviewer Agent Chat rehearsal must run the preflight gate before Chromium." >&2
  exit 1
fi
if ! rg -q 'installReadOnlyMutationGuard|REVIEWER_READ_ONLY_MUTATION_BLOCKED' \
  .codex/skills/reviewer-app-testing/scripts/reviewer-session-harness.mjs; then
  echo "Reviewer browser harness must guard read-only runs against state-changing requests." >&2
  exit 1
fi
if rg -q 'createDecipheriv|pbkdf2Sync|decryptAesGcm|deriveVaultKey' \
  .codex/skills/reviewer-app-testing/scripts; then
  echo "Reviewer Node harness must not derive or decrypt vault keys." >&2
  exit 1
fi
node --check .codex/skills/pkm-upgrade-rehearsal/scripts/reviewer-pkm-app-rehearsal.mjs
node .codex/skills/pkm-upgrade-rehearsal/scripts/reviewer-pkm-app-rehearsal.mjs --help >/dev/null
if PKM_REVIEWER_DECRYPTED_OUTPUT="$repo_root/AGENTS.md" \
  node .codex/skills/pkm-upgrade-rehearsal/scripts/reviewer-pkm-app-rehearsal.mjs \
  --help >/dev/null 2>&1; then
  echo "Reviewer rehearsal accepted decrypted output outside tmp/." >&2
  exit 1
fi

echo "Reviewer app skill checks passed."
