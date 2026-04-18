---
name: autonomous-rca-governance
description: Use when a core runtime, CI, or UAT release surface is failing and the task is to classify the failure, choose the smallest safe remediation, rerun authoritative checks, and preserve machine-readable RCA artifacts.
---

# Hushh Autonomous RCA Governance Skill

## Purpose and Trigger

- Primary scope: `autonomous-rca-governance-intake`
- Trigger on core runtime, CI, deploy, and semantic-release failures that need repeated RCA and a structured remediation loop.
- Avoid overlap with broad repo discovery or product implementation that is not anchored to a failing authority surface.

## Coverage and Ownership

- Role: `owner`
- Owner family: `autonomous-rca-governance`

Owned repo surfaces:

1. `.codex/skills/autonomous-rca-governance`
2. `scripts/ops/verify-env-secrets-parity.py`
3. `scripts/ops/verify_uat_release.py`
4. `scripts/ci/verify-runtime-config-contract.py`
5. `scripts/ci/cloudrun-rollback.sh`

Non-owned surfaces:

1. `repo-operations`
2. `backend-runtime-governance`
3. `quality-contracts`
4. `contributor-onboarding`

## Do Use

1. Distinguishing `secret_missing` vs `runtime_mount_legacy` vs `runtime_behavior_failed`.
2. Running repeated RCA for UAT, core runtime, or CI failures with machine-readable artifacts.
3. Tightening the repo-local RCA taxonomy, resume artifacts, or canonical RCA command surface.

## Do Not Use

1. Broad feature work that is not anchored to a failing core authority surface.
2. Docs-home or taxonomy work that does not change the RCA loop itself.
3. Production promotion decisions.

## Read First

1. `docs/reference/operations/ci.md`
2. `docs/reference/operations/env-and-secrets.md`
3. `.codex/skills/repo-operations/SKILL.md`
4. `.codex/skills/quality-contracts/SKILL.md`

## Workflow

1. Start with `./bin/hushh codex rca --surface <uat|runtime|ci>` and preserve the generated report.
2. Classify failures before editing anything:
   - `secret_missing`
   - `runtime_mount_missing`
   - `runtime_mount_legacy`
   - `runtime_behavior_failed`
   - `smoke_overlay_dependency_leak`
   - `db_contract_drift`
3. Apply the smallest safe remediation for the highest-signal blocking class first.
4. Rerun the authoritative checks twice after the remediation instead of trusting the first green pass.
5. Stop only when the blocking classifications are empty or a real permissions/product boundary is explicit.
6. Advisory doc/skill drift should be recorded, but it must not block the loop unless it masks a core runtime failure.

## Handoff Rules

1. Use `repo-operations` when the fix is primarily in deploy workflows, Cloud Run, or Secret Manager wiring.
2. Use `backend-runtime-governance` when the fix is in backend runtime ownership or service behavior.
3. Use `quality-contracts` when the authoritative proof is missing or the semantic gate itself is wrong.
4. Use `contributor-onboarding` when bootstrap/doctor/runtime files cause false RCA signals.

## Required Checks

```bash
./bin/hushh codex rca --surface runtime --text
./bin/hushh codex rca --surface ci --text
./bin/hushh codex rca --surface uat --text
python3 -m py_compile .codex/skills/autonomous-rca-governance/scripts/rca_runner.py
```
