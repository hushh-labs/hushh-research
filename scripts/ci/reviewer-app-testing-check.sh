#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

node --check .agents/skills/reviewer-app-testing/scripts/reviewer-session-harness.mjs
node --test .agents/skills/reviewer-app-testing/tests/*.test.mjs
node --check .agents/skills/reviewer-app-testing/scripts/reviewer-rehearsal-preflight.mjs
node --check .agents/skills/reviewer-app-testing/scripts/verify-reviewer-byok-navigation.mjs
node --check .agents/skills/reviewer-app-testing/scripts/verify-reviewer-agent-chat.mjs
node --check .agents/skills/reviewer-app-testing/scripts/verify-reviewer-pwm.mjs
node .agents/skills/reviewer-app-testing/scripts/verify-reviewer-pwm.mjs --help >/dev/null
consent-protocol/.venv/bin/python -m py_compile \
  .agents/skills/reviewer-app-testing/scripts/reconcile-reviewer-identity.py
node .agents/skills/reviewer-app-testing/scripts/reviewer-rehearsal-preflight.mjs --help >/dev/null
consent-protocol/.venv/bin/python \
  .agents/skills/reviewer-app-testing/scripts/reconcile-reviewer-identity.py \
  --help >/dev/null
if ! rg -q 'prepareReviewerRehearsal' \
  .agents/skills/reviewer-app-testing/scripts/verify-reviewer-byok-navigation.mjs; then
  echo "Reviewer browser rehearsal must run the preflight gate before Chromium." >&2
  exit 1
fi
if ! rg -q 'prepareReviewerRehearsal' \
  .agents/skills/reviewer-app-testing/scripts/verify-reviewer-agent-chat.mjs; then
  echo "Reviewer Agent Chat rehearsal must run the preflight gate before Chromium." >&2
  exit 1
fi
if ! rg -q 'installReadOnlyMutationGuard|REVIEWER_READ_ONLY_MUTATION_BLOCKED' \
  .agents/skills/reviewer-app-testing/scripts/reviewer-session-harness.mjs; then
  echo "Reviewer browser harness must guard read-only runs against state-changing requests." >&2
  exit 1
fi
if rg -q 'createDecipheriv|pbkdf2Sync|decryptAesGcm|deriveVaultKey' \
  .agents/skills/reviewer-app-testing/scripts; then
  echo "Reviewer Node harness must not derive or decrypt vault keys." >&2
  exit 1
fi
node --check .agents/skills/pkm-upgrade-rehearsal/scripts/reviewer-pkm-app-rehearsal.mjs
node .agents/skills/pkm-upgrade-rehearsal/scripts/reviewer-pkm-app-rehearsal.mjs --help >/dev/null
if PKM_REVIEWER_DECRYPTED_OUTPUT="$repo_root/AGENTS.md" \
  node .agents/skills/pkm-upgrade-rehearsal/scripts/reviewer-pkm-app-rehearsal.mjs \
  --help >/dev/null 2>&1; then
  echo "Reviewer rehearsal accepted decrypted output outside tmp/." >&2
  exit 1
fi

echo "Reviewer app skill checks passed."
