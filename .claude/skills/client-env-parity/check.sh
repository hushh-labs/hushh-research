#!/usr/bin/env bash
# Fails when a required NEXT_PUBLIC_* credential is missing from a build lane.
#
# Usage:  .claude/skills/client-env-parity/check.sh
# Exit:   0 = every required var is written by every lane that needs it
#         1 = at least one gap (printed)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MANIFEST="${ROOT}/.claude/skills/client-env-parity/required-client-env.tsv"

WEB_LANE="${ROOT}/deploy/frontend.cloudbuild.yaml"
TF_LANE="${ROOT}/.github/workflows/ship-ios-testflight.yml"
AS_LANE="${ROOT}/.github/workflows/release-ios-appstore.yml"
TF_MATERIALIZER="${ROOT}/scripts/ci/materialize-ios-uat-build-contract.sh"

for f in "$MANIFEST" "$WEB_LANE" "$TF_LANE" "$AS_LANE" "$TF_MATERIALIZER"; do
  [ -f "$f" ] || { echo "MISSING FILE: $f" >&2; exit 1; }
done

# A lane "provides" a var when it passes it as a Docker build argument (web) or
# writes it into the build env with the `put` helper (native). Both are the
# real mechanisms; grepping for the bare name would match comments and pass
# a lane that only mentions the var.
web_provides()  { grep -qE "build-arg[[:space:]]+$1=" "$WEB_LANE"; }
# TestFlight used to write the build environment inline. It now invokes one
# shared UAT materializer so the TestFlight and physical-iPhone lanes cannot
# drift. Count a value only when the workflow invokes that exact helper and the
# helper writes it to GITHUB_ENV; a mention in a comment never satisfies this
# release gate.
tf_provides()   {
  grep -qE "put[[:space:]]+$1[[:space:]]" "$TF_LANE" || {
    grep -qE "bash[[:space:]]+scripts/ci/materialize-ios-uat-build-contract\\.sh" "$TF_LANE" \
      && grep -qE "put_env[[:space:]]+$1[[:space:]]" "$TF_MATERIALIZER"
  }
}
as_provides()   { grep -qE "put[[:space:]]+$1[[:space:]]" "$AS_LANE"; }

fail=0
checked=0

while IFS=$'\t' read -r var lanes why; do
  case "$var" in ''|\#*) continue ;; esac
  [ -n "${lanes:-}" ] || continue
  checked=$((checked + 1))
  [ "$lanes" = "all" ] && lanes="web,ios-testflight,ios-appstore"

  IFS=',' read -ra want <<< "$lanes"
  for lane in "${want[@]}"; do
    case "$lane" in
      web)            web_provides "$var" || { echo "GAP  web             $var"; echo "       why: $why"; fail=1; } ;;
      ios-testflight) tf_provides  "$var" || { echo "GAP  ios-testflight  $var"; echo "       why: $why"; fail=1; } ;;
      ios-appstore)   as_provides  "$var" || { echo "GAP  ios-appstore    $var"; echo "       why: $why"; fail=1; } ;;
      *)              echo "UNKNOWN LANE '$lane' for $var (manifest error)"; fail=1 ;;
    esac
  done
done < "$MANIFEST"

echo
if [ "$fail" -eq 0 ]; then
  echo "OK — $checked required client credentials reach every lane that needs them."
else
  echo "FAIL — a required credential is missing from a build lane."
  echo "A gap here ships a build where the feature is silently dead, not broken."
fi
exit "$fail"
