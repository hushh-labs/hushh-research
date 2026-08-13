#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

python3 scripts/ci/verify-pr-governance-sections.py
python3 scripts/ci/verify-protected-pipeline-edits.py
python3 scripts/ci/verify-protected-pipeline-edits.py --self-test
python3 scripts/ci/verify-pr-base-policy.py --self-test
python3 scripts/ci/verify-branch-governance-doc-consistency.py
python3 scripts/ci/verify-branch-governance-doc-consistency.py --self-test
python3 scripts/ci/test_resolve_deploy_scope.py
python3 scripts/ci/test_resolve_uat_verification_plan.py
python3 scripts/ci/test_change_aware_verification_wiring.py
python3 scripts/ci/test_pkm_upgrade_gate_scope.py
# The offline half of the deploy-identity comparison: does the record that declares
# who may mint a production deploy token still say what it must? Runs everywhere
# because it needs no cloud. The live half needs IAM read, which the deploy lane's
# federated identity deliberately does not have, so it runs from the setup script
# instead -- with the operator credential that can genuinely see.
python3 scripts/ci/verify-deploy-identity-provenance.py --record-only
python3 scripts/ci/test_verify_deploy_identity_provenance.py
./bin/hushh docs verify
./bin/hushh codex data-model-audit
python3 scripts/ops/generate_runtime_topology_index.py --check
python3 scripts/licenses/verify_apache_surface.py
python3 scripts/ci/verify-runtime-config-contract.py
python3 .codex/skills/agent-orchestration-governance/scripts/agent_orchestration_check.py
python3 .codex/skills/agent-orchestration-governance/scripts/agent_orchestration_check.py --self-test
python3 .codex/skills/agent-orchestration-governance/scripts/agent_fleet_audit.py --text
python3 .codex/skills/agent-orchestration-governance/scripts/agent_router_smoke.py
python3 .codex/skills/agent-orchestration-governance/scripts/sync_claude_agents.py --check
python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py
python3 .codex/skills/repo-context/scripts/architecture_fitness.py --self-test
python3 .codex/skills/repo-context/scripts/architecture_fitness.py --limit 20
python3 .codex/skills/codex-skill-authoring/scripts/trigger_evals.py
python3 .codex/skills/codex-skill-authoring/scripts/test_trigger_evals.py
python3 .codex/skills/codex-skill-authoring/scripts/compact_kernel_smoke.py
python3 .claude/skills/codex-bridge/scripts/route.py --check
python3 .claude/skills/codex-bridge/scripts/test_route_hook.py
# Fails when a required NEXT_PUBLIC_* credential is missing from a build lane.
# Offline and fast. The origin-restriction half of this skill needs gcloud and
# stays out of CI on purpose — run it from the skill before a release.
bash .claude/skills/client-env-parity/check.sh
./bin/hushh db verify-release-contract
./bin/hushh db report-prod-posture
