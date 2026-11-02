#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

set -euo pipefail

# Every check below runs, even after one fails, so a single CI run reports every
# governance failure instead of the first one. The run still exits non-zero (with
# the first failing check's status) when anything failed. A check that cannot be
# executed at all (exit 126/127: missing tool or script) stops the run at once,
# because every later result would be noise from the same broken environment.

failures=()
first_status=0
checks_run=0

check() {
  local status=0
  checks_run=$((checks_run + 1))
  "$@" || status=$?
  ((status == 0)) && return 0
  if ((status == 126 || status == 127)); then
    echo "::error title=Governance stopped::'$*' could not be executed (exit $status)." >&2
    exit "$status"
  fi
  failures+=("[exit $status] $*")
  ((first_status != 0)) || first_status=$status
  echo "::error title=Governance check failed::$* (exit $status)" >&2
}

report() {
  if ((${#failures[@]} == 0)); then
    echo "All $checks_run governance checks passed."
    return 0
  fi
  {
    echo
    echo "${#failures[@]} of $checks_run governance checks failed:"
    printf '  %s\n' "${failures[@]}"
  } >&2
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "### ${#failures[@]} of $checks_run governance checks failed"
      printf -- '- `%s`\n' "${failures[@]}"
    } >>"$GITHUB_STEP_SUMMARY"
  fi
  return "$first_status"
}

# Seeded failures run in subshells, so they never touch the real run's state.
self_test() {
  local output status=0
  output="$(
    GITHUB_STEP_SUMMARY=''
    { check true; check false; check bash -c 'exit 3'; check true; report; } 2>&1
  )" || status=$?
  if [[ $status -ne 1 || "$output" != *"2 of 4 governance checks failed"* ||
        "$output" != *"[exit 1] false"* || "$output" != *"[exit 3] bash -c exit 3"* ]]; then
    printf 'self-test: every failure must be reported, exiting with the first status (got %s):\n%s\n' "$status" "$output" >&2
    return 1
  fi
  status=0
  output="$(
    GITHUB_STEP_SUMMARY=''
    { check false; check hushh-governance-missing-tool; check false; report; } 2>&1
  )" || status=$?
  if [[ $status -ne 127 || "$output" == *"governance checks failed"* ]]; then
    printf 'self-test: a missing tool must stop the run with exit 127 (got %s):\n%s\n' "$status" "$output" >&2
    return 1
  fi
  echo "repo-governance-check self-test passed."
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Source ownership and modularity first, then the controller/docs checks.
check bash scripts/ci/repo-governance-check.sh --self-test
check python3 .agents/skills/codex-skill-authoring/scripts/skill_lint.py
check python3 .agents/skills/agent-orchestration-governance/scripts/agent_orchestration_check.py
check python3 .agents/skills/agent-orchestration-governance/scripts/agent_orchestration_check.py --self-test
check python3 .agents/skills/repo-context/scripts/architecture_fitness.py --self-test
check python3 .agents/skills/repo-context/scripts/architecture_fitness.py --baseline docs/reference/quality/architecture-fitness-baseline.json --limit 20

check python3 scripts/ci/verify-pr-governance-sections.py
check python3 scripts/ci/verify-protected-pipeline-edits.py
check python3 scripts/ci/verify-protected-pipeline-edits.py --self-test
check python3 scripts/ci/verify-protected-behavior-tests.py
check python3 scripts/ci/verify-protected-behavior-tests.py --self-test
check python3 scripts/ci/live-memory-source-gate.py
check python3 scripts/ci/live-memory-source-gate.py --self-test
check python3 scripts/ci/test_live_memory_pr_context.py
check python3 scripts/ci/test_github_security_authority.py
check python3 scripts/ci/test_github_security_receipt.py
check python3 scripts/ci/verify-pr-base-policy.py --self-test
check python3 scripts/ci/verify-queue-entry-reuses-pr-validation.py --self-test
check python3 scripts/ci/verify-branch-governance-doc-consistency.py
check python3 scripts/ci/verify-branch-governance-doc-consistency.py --self-test
check python3 scripts/ci/test_verify_deployment_environment_governance.py
check python3 scripts/ci/test_capacity_gate_rerun_context.py
check python3 scripts/ci/test_readiness_exam_workflow.py
check python3 scripts/ci/test_release_cadence.py
check python3 scripts/ci/test_release_cadence_qualification.py
check python3 scripts/ci/test_uat_exact_ci.py
check python3 scripts/ci/test_release_cadence_maintenance.py
check python3 scripts/ci/test_release_cadence_monitor.py
check python3 scripts/ci/test_release_cadence_checkpoint.py
check bash scripts/ci/verify-protocol-ci-parity.sh --self-test
check python3 scripts/ci/test_protocol_manifest_transport.py
check python3 scripts/ci/test_apply_governance_teams.py
check python3 scripts/ci/test_resolve_deploy_scope.py
check python3 scripts/ci/test_cloudrun_retention.py
check python3 scripts/ci/test_uat_per_revision_drain.py
check python3 scripts/ci/test_pending_uat_retention_state.py
check python3 scripts/ci/test_retention_preflight_checkpoint.py
check python3 scripts/ci/test_retention_error_diagnostics.py
check python3 scripts/ci/test_retention_preparing.py
check python3 scripts/ci/test_retention_preflight_evidence.py
check python3 scripts/ci/test_retention_production_evidence.py
check python3 scripts/ci/test_retention_production_clock_evidence.py
check python3 scripts/ci/test_retention_uat_guard_evidence.py
check python3 scripts/ci/test_wait_uat_capacity.py
check python3 scripts/ci/test_runtime_capacity_budget.py
check python3 scripts/ci/test_runtime_capacity_uat_health_job.py
check python3 scripts/ci/test_runtime_capacity_inventory.py
check python3 scripts/ci/test_runtime_capacity_volume.py
check python3 scripts/ci/test_runtime_capacity_isolated.py
check python3 scripts/ci/test_runtime_capacity_route_secrets.py
check python3 scripts/ci/test_production_capacity_bridge.py
check python3 scripts/ci/test_production_capacity_recovery.py
check python3 scripts/ci/test_production_verification.py
check python3 scripts/ci/test_production_verification_workflow.py
check python3 scripts/ci/test_verify_passkey_domain_associations.py
check python3 scripts/ci/test_verify_prod_places_readiness.py
check python3 scripts/ci/test_resolve_uat_verification_plan.py
check python3 scripts/ci/test_change_aware_verification_wiring.py
# Base Freshness Gate is bounded on PRs into main; this proves it still blocks
# a stale merge-base or a file main changed after the tested base, and that
# block mode (merge queue, integration/pr-train) still fails any lag.
check python3 scripts/ci/test_check_main_sync.py
# The web lanes run as matrices (targeted node/browser legs, Vitest shards);
# this proves the split still runs every pack, shard and verifier exactly once.
check python3 scripts/ci/test_ui_contract_gate.py
check python3 scripts/ci/test_web_ci_lane_partition.py
check python3 scripts/ci/test_pkm_upgrade_gate_scope.py
# The offline half of the deploy-identity comparison: does the record that declares
# who may mint a production deploy token still say what it must? Runs everywhere
# because it needs no cloud. The live half needs IAM read, which the deploy lane's
# federated identity deliberately does not have, so it runs from the setup script
# instead -- with the operator credential that can genuinely see.
check python3 scripts/ci/verify-deploy-identity-provenance.py --record-only
check python3 scripts/ci/test_verify_deploy_identity_provenance.py
check python3 scripts/ci/test_private_native_artifact.py
check node --test scripts/release/dispatch-ios-appstore.test.mjs
check node --test scripts/release/dispatch-android-playstore.test.mjs
check python3 scripts/ci/test_resolve_ios_build_number.py
# PR Validation only restores the Next.js and Swift package caches; main saves
# them under the keys the PR lanes look up.
check python3 scripts/ci/test_ci_cache_scopes.py
check ./bin/hushh docs verify
check ./bin/hushh codex data-model-audit
check python3 scripts/ops/generate_runtime_topology_index.py --check
check python3 scripts/licenses/verify_apache_surface.py
check python3 scripts/ci/verify-runtime-config-contract.py
check python3 .agents/skills/agent-orchestration-governance/scripts/agent_fleet_audit.py --text
check python3 .agents/skills/agent-orchestration-governance/scripts/agent_router_smoke.py
check python3 .agents/skills/codex-skill-authoring/scripts/trigger_evals.py
check python3 .agents/skills/codex-skill-authoring/scripts/test_trigger_evals.py
check python3 .agents/skills/codex-skill-authoring/scripts/compact_kernel_smoke.py
check python3 .agents/routing/scripts/route.py --check
check python3 .agents/routing/scripts/test_route_requests.py
# Fails when a required NEXT_PUBLIC_* credential is missing from a build lane.
# Offline and fast. The origin-restriction half of this skill needs gcloud and
# stays out of CI on purpose — run it from the skill before a release.
check bash .agents/skills/client-env-parity/check.sh
check ./bin/hushh db verify-release-contract
check ./bin/hushh db report-prod-posture

# Every secret bound by deploy/backend.cloudbuild.yaml must be passed by each
# deploy lane, or recorded as a deliberate omission. An unrecorded gap ships a
# service missing that environment variable with no error anywhere.
check python3 scripts/ci/check-deploy-secret-coverage.py

report
