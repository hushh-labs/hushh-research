#!/usr/bin/env bash
# ONE command that takes a commit from "unverified" to "serving traffic, proven",
# without GitHub Actions.
#
# WHY THIS EXISTS: when GitHub's runners are unavailable, the checks and the
# deploy are both still perfectly runnable -- what disappears is the thing that
# RUNS THEM IN ORDER and refuses to continue when a step fails. That ordering is
# the actual product of a CI/CD system. This script is that ordering.
#
#   PREFLIGHT -> VERIFY -> DEPLOY -> PROVE -> REPORT
#
# Each stage refuses to start unless the one before it passed. There is no way
# to reach DEPLOY without a complete, green VERIFY on the exact same commit.
#
# WHAT IT DOES NOT DO: it does not weaken any control. The commit must still be
# a real ancestor of origin/main, the deploy still labels its provenance, UAT is
# still refused because that project's IAM deny policy routes UAT through CI by
# design, and a failed health check still rolls traffic back.
#
# Usage:
#   scripts/ops/release_pipeline.sh --env production
#   scripts/ops/release_pipeline.sh --env production --sha <sha>
#   scripts/ops/release_pipeline.sh --env production --dry-run
#   scripts/ops/release_pipeline.sh --env production --from deploy   # resume
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

TARGET_ENV=""
DEPLOY_SHA=""
SCOPE="auto"
FROM_STAGE="preflight"
DRY_RUN=0
GATE_MODE="full"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) TARGET_ENV="$2"; shift 2 ;;
    --sha) DEPLOY_SHA="$2"; shift 2 ;;
    --scope) SCOPE="$2"; shift 2 ;;
    --from) FROM_STAGE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --fast-gate) GATE_MODE="fast"; shift ;;
    -h|--help) sed -n '1,30p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

STAGES=(preflight verify deploy prove report)
stage_index() { local i=0; for s in "${STAGES[@]}"; do [[ "$s" == "$1" ]] && { echo "$i"; return; }; i=$((i+1)); done; echo "-1"; }
START_AT="$(stage_index "$FROM_STAGE")"
[[ "$START_AT" == "-1" ]] && { echo "Unknown --from stage '$FROM_STAGE'. One of: ${STAGES[*]}" >&2; exit 2; }

banner() { printf '\n\033[1;44;97m  %-72s\033[0m\n' "$*"; }
step()   { printf '\033[1;36m→ %s\033[0m\n' "$*"; }
ok()     { printf '\033[0;32m✔ %s\033[0m\n' "$*"; }
warn()   { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die()    { printf '\n\033[1;41;97m  PIPELINE STOPPED  \033[0m\n\033[0;31m%s\033[0m\n' "$*" >&2; exit 1; }

[[ -z "$TARGET_ENV" ]] && die "--env is required (production, uat, or dev)."

GATE_DIR="${HUSHH_GATE_REPORT_DIR:-${TMPDIR:-/tmp}}"
PIPELINE_LOG="$(mktemp -d "${TMPDIR:-/tmp}/release-pipeline-XXXXXX")"

# ---------------------------------------------------------------- 1. PREFLIGHT
# Resolve the commit and prove we are allowed to finish, BEFORE running an hour
# of checks. Discovering a permission wall after a green gate wastes the gate.
banner "STAGE 1/5  PREFLIGHT"

step "Resolving the commit to ship"
git fetch --no-tags origin main >/dev/null 2>&1 || warn "Could not reach origin; using local refs."
[[ -z "$DEPLOY_SHA" ]] && DEPLOY_SHA="$(git rev-parse origin/main)"
DEPLOY_SHA="$(git rev-parse "$DEPLOY_SHA")"
SHORT_SHA="${DEPLOY_SHA:0:12}"
ok "Commit: ${DEPLOY_SHA}"

step "Confirming the commit is really on main"
git merge-base --is-ancestor "$DEPLOY_SHA" origin/main \
  || die "${SHORT_SHA} is not an ancestor of origin/main.
Shipping a commit that never landed on main is a worse failure than a delayed
release. Merge it first, then re-run this pipeline."
ok "Commit is an ancestor of origin/main"

step "Checking this account can actually complete a ${TARGET_ENV} deploy"
case "$TARGET_ENV" in
  production) GCP_PROJECT_ID="hushh-pda" ;;
  uat)        GCP_PROJECT_ID="hushh-pda-uat" ;;
  dev)        GCP_PROJECT_ID="hushh-pda-dev" ;;
  *) die "--env must be production, uat, or dev (got '${TARGET_ENV}')." ;;
esac

PERMS="$(curl -sS -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -d '{"permissions":["cloudbuild.builds.create","run.services.update"]}' \
  "https://cloudresourcemanager.googleapis.com/v1/projects/${GCP_PROJECT_ID}:testIamPermissions" 2>/dev/null || echo '{}')"

for perm in cloudbuild.builds.create run.services.update; do
  grep -q "$perm" <<<"$PERMS" || die "This account cannot '${perm}' on ${GCP_PROJECT_ID}.

For UAT this is expected and correct: the 'uat-deploy-authority-lock' IAM deny
policy sends every UAT deploy through the CI service account on purpose. It is a
working safety control, not a misconfiguration. Do not try to remove it.

What you can do instead:
  - ship this commit to production or dev with this pipeline, or
  - wait for GitHub runners and re-run the governed deploy-uat workflow."
done
ok "Deploy authority confirmed on ${GCP_PROJECT_ID}"
[[ "$START_AT" -gt 0 ]] && warn "Resuming from '${FROM_STAGE}'; earlier stages were skipped."

# ------------------------------------------------------------------- 2. VERIFY
# Run every CI check against the EXACT commit being shipped -- in a throwaway
# worktree, so the pipeline never depends on, or disturbs, whatever the user has
# checked out. Other agents share this checkout; a pipeline that runs `git
# checkout` under them would destroy their work.
banner "STAGE 2/5  VERIFY  (every check GitHub Actions would run)"

GATE_REPORT="${GATE_DIR}/hushh-ci-gate-${DEPLOY_SHA}.json"

if [[ "$START_AT" -le 1 ]]; then
  VERIFY_WT="${PIPELINE_LOG}/verify-worktree"
  step "Creating a clean worktree at ${SHORT_SHA}"
  git worktree add --detach "$VERIFY_WT" "$DEPLOY_SHA" >/dev/null 2>&1 \
    || die "Could not create a verification worktree at ${SHORT_SHA}."
  # shellcheck disable=SC2064
  trap "git worktree remove --force '$VERIFY_WT' >/dev/null 2>&1 || true" EXIT

  # The gate needs the Python interpreter CI uses. A fresh worktree has no venv,
  # and building one takes minutes, so reuse the primary checkout's if present.
  if [[ ! -e "${VERIFY_WT}/consent-protocol/.venv" && -d "${REPO_ROOT}/consent-protocol/.venv" ]]; then
    ln -sfn "${REPO_ROOT}/consent-protocol/.venv" "${VERIFY_WT}/consent-protocol/.venv"
  fi

  step "Running the full CI gate"
  GATE_ARGS=()
  [[ "$GATE_MODE" == "fast" ]] && GATE_ARGS+=(--fast)
  if HUSHH_GATE_REPORT_DIR="$GATE_DIR" \
     bash "${VERIFY_WT}/scripts/ci/local-release-gate.sh" "${GATE_ARGS[@]}"; then
    ok "All checks passed for ${SHORT_SHA}"
  else
    die "CI checks failed for ${SHORT_SHA}. Nothing was deployed.
The per-stage results are above and in:
  ${GATE_REPORT}
Fix the failing stages, then re-run this pipeline."
  fi

  git worktree remove --force "$VERIFY_WT" >/dev/null 2>&1 || true
  trap - EXIT
else
  warn "Skipping VERIFY (--from ${FROM_STAGE})."
fi

# The deploy stage is only allowed to run against a complete, green report for
# this exact commit. This is checked even when VERIFY was skipped, so --from
# cannot be used to sneak past verification.
step "Confirming a complete, green report exists for ${SHORT_SHA}"
[[ -f "$GATE_REPORT" ]] || die "No CI report for ${SHORT_SHA}.
Re-run without --from so the VERIFY stage produces one."
GATE_STATE="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["verdict"], d["complete"])' "$GATE_REPORT")"
[[ "$GATE_STATE" == "passed True" ]] || die "The CI report for ${SHORT_SHA} is '${GATE_STATE}', not 'passed True'.
A partial run (--fast-gate or a single stage) cannot authorize a deploy."
ok "Verification proven for ${SHORT_SHA}"

# ------------------------------------------------------------------- 3. DEPLOY
banner "STAGE 3/5  DEPLOY  (build, promote, roll back on failure)"

if [[ "$START_AT" -le 2 ]]; then
  DEPLOY_ARGS=(--env "$TARGET_ENV" --sha "$DEPLOY_SHA" --scope "$SCOPE" --skip-ci-check)
  [[ "$DRY_RUN" -eq 1 ]] && DEPLOY_ARGS+=(--dry-run)
  step "Handing off to the deploy driver"
  HUSHH_GATE_REPORT_DIR="$GATE_DIR" \
    bash scripts/ops/cloudbuild_release.sh "${DEPLOY_ARGS[@]}" \
    || die "Deploy failed. If traffic had already moved, the driver rolled it
back to the previous working version and said so above."
  ok "Deploy stage finished"
else
  warn "Skipping DEPLOY (--from ${FROM_STAGE})."
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  banner "DRY RUN COMPLETE  (nothing was deployed)"
  exit 0
fi

# -------------------------------------------------------------------- 4. PROVE
# The deploy driver already gates on provenance, environment parity and HTTP
# health. This stage answers the different question a person actually asks:
# "is the thing I shipped the thing that is now serving?"
banner "STAGE 4/5  PROVE  (is my commit the one serving traffic?)"

if [[ "$START_AT" -le 3 ]]; then
  GCP_REGION="us-central1"
  serving_sha() {
    local svc="$1" rev
    rev="$(gcloud run services describe "$svc" --project="$GCP_PROJECT_ID" \
      --region="$GCP_REGION" --format='value(status.traffic[0].revisionName)' 2>/dev/null || true)"
    [[ -z "$rev" ]] && return 0
    gcloud run revisions describe "$rev" --project="$GCP_PROJECT_ID" \
      --region="$GCP_REGION" --format='value(metadata.labels.deploy-sha)' 2>/dev/null || true
  }
  PROVEN=1
  for svc in consent-protocol hushh-webapp; do
    LIVE_SHA="$(serving_sha "$svc")"
    if [[ -z "$LIVE_SHA" ]]; then
      warn "${svc}: could not read the serving commit."
    elif [[ "$LIVE_SHA" == "$DEPLOY_SHA" ]]; then
      ok "${svc} is serving ${SHORT_SHA}"
    else
      warn "${svc} is serving ${LIVE_SHA:0:12}, not ${SHORT_SHA} (may be out of scope for this deploy)"
      PROVEN=0
    fi
  done
  [[ "$PROVEN" -eq 1 ]] && ok "Every deployed service is serving the intended commit"
else
  warn "Skipping PROVE (--from ${FROM_STAGE})."
fi

# ------------------------------------------------------------------- 5. REPORT
banner "STAGE 5/5  REPORT"

SUMMARY="${PIPELINE_LOG}/pipeline-summary.json"
DEPLOY_SHA="$DEPLOY_SHA" TARGET_ENV="$TARGET_ENV" GCP_PROJECT_ID="$GCP_PROJECT_ID" \
GATE_REPORT="$GATE_REPORT" SUMMARY="$SUMMARY" \
python3 - <<'PY'
import json, os, subprocess
from pathlib import Path

gate = {}
gate_path = Path(os.environ["GATE_REPORT"])
if gate_path.exists():
    gate = json.loads(gate_path.read_text(encoding="utf-8"))

payload = {
    "sha": os.environ["DEPLOY_SHA"],
    "environment": os.environ["TARGET_ENV"],
    "project": os.environ["GCP_PROJECT_ID"],
    "lane": "release_pipeline (GitHub Actions unavailable)",
    "generated_at": subprocess.run(
        ["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"], capture_output=True, text=True
    ).stdout.strip(),
    "verification": {
        "verdict": gate.get("verdict"),
        "complete": gate.get("complete"),
        "toolchain": gate.get("toolchain"),
        "stages": [
            {"stage": s["stage"], "result": s["result"]} for s in gate.get("stages", [])
        ],
    },
}
Path(os.environ["SUMMARY"]).write_text(json.dumps(payload, indent=2), encoding="utf-8")
passed = sum(1 for s in gate.get("stages", []) if s["result"] == "passed")
print(f"  Commit shipped:  {payload['sha'][:12]}")
print(f"  Environment:     {payload['environment']} ({payload['project']})")
print(f"  Checks passed:   {passed} of {len(gate.get('stages', []))}")
print(f"  Evidence:        {os.environ['SUMMARY']}")
PY

banner "PIPELINE COMPLETE"
echo "Once GitHub runners recover, re-run the governed deploy workflow for this"
echo "commit so the release carries normal CI provenance."
