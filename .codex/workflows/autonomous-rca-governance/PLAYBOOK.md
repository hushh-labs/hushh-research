# Autonomous RCA Governance

Use this workflow pack when the task matches `autonomous-rca-governance`.

## Goal

Classify core runtime and release failures into a small RCA taxonomy, run the smallest authoritative checks, and preserve structured artifacts so later agents can resume without rediscovering the same blocker.

## Steps

1. Start with `autonomous-rca-governance` and run `./bin/hushh codex rca --surface <uat|runtime|ci>`.
2. Separate the blocking class before editing anything:
   `secret_missing`, `runtime_mount_missing`, `runtime_mount_legacy`, `runtime_behavior_failed`, `smoke_overlay_dependency_leak`, `db_contract_drift`.
3. Route the fix to the smallest owner skill that can actually remediate the blocking class.
4. Rerun the authoritative checks twice after the remediation instead of trusting the first green pass.
5. Do not call the task complete while the relevant deploy or UAT run for the touched SHA is still queued or in progress; keep monitoring until the release chain is terminal.
6. Keep advisory doc/skill drift recorded, but do not let it block the loop unless it masks a core runtime failure.

## Common Drift Risks

1. collapsing missing-secret and old-mount failures into the same remediation
2. calling UAT healthy when only the secret-sync layer passed
3. failing to preserve a machine-readable report for the next agent
4. letting maintainer smoke overlays leak back into canonical runtime files
