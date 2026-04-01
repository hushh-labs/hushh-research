# Backend Scripts Map

This directory is maintainer-only. It is not part of the normal contributor bootstrap path.

If you are new to the repo, start at the monorepo root with:

```bash
npm run bootstrap
```

Use the scripts here only when you are working on backend verification, migrations, or operator maintenance.

## Keep In Mind

- Runtime and deploy entrypoints live outside this folder.
- CI-owned scripts are the safest place to start because they are exercised regularly.
- Backfills, cleanup tools, and reset scripts are intentionally isolated here so they do not leak into contributor onboarding.
- One-time migration notes are no longer kept here once the migration is complete; use git history or the relevant PR for historical context.

## Script Groups

### CI and Verification

- `run-test-ci.sh`: canonical backend CI executor for the Python subtree.
- `test-ci.manifest.txt`: backend CI file manifest.
- `verify_adk_a2a_compliance.py`: protocol compliance verification.
- `verify_consent_audit_schema.py`: consent audit schema validation.
- `verify_iam_schema.py`: IAM schema validation.
- `verify_vault_schema.py`: vault schema validation.
- `uat_kai_regression_smoke.py`: UAT-focused Kai smoke coverage for maintainers.

### Inspection and Evaluation

- `inspect_pkm_upgrade_state.py`: inspect per-user PKM upgrade status, runs, steps, and failure context.
- `audit_legacy_pkm_readonly.py`: read-only redacted audit for legacy world-model / PKM blobs; decrypts locally in memory and emits structure-only output with no plaintext values.
- `eval_pkm_structure_agent.py`: evaluate PKM structure-agent output.
- `eval_portfolio_stream_quality.py`: evaluate portfolio/stream quality signals.
- `run_kai_accuracy_suite.py`: maintainer-only Kai quality suite.

### Data Imports and Normalization

- `import_tickers.py`: ticker reference import.
- `normalize_user_data_format.py`: normalize legacy user payloads.
- `migrate_financial_v2.py`: deterministic financial model migration support.
- `init_supabase_schema.sql`: schema bootstrap for controlled maintenance scenarios.

### Reset, Seed, and Repair

- `seed_investors.py`: local/UAT investor seed flow.
- `reset_dev_user_data.py`: reset a developer/test user state.
- `reset_finance_root_user.py`: reset the finance-root testing user.
- `fix_partial_vault_rows.py`: targeted repair for partial vault rows.

### Backfills and Cleanup

- `backfill_actor_identity_cache.py`: rebuild actor identity cache for existing rows.
- `cleanup_consent_audit_noise.py`: remove audit noise with explicit operator intent.
- `cleanup_user_consent_surface.py`: repair consent-surface rows after contract changes.

### Observability and Ops Subfolders

- `ops/`: backend operational helpers that support release and infrastructure maintenance.
- `observability/`: logging and telemetry helpers.
- `ci/`: backend CI helper internals.
- `renaissance/`: specialized maintainer experiments and one-off evaluation support.

## What Not To Do

- Do not treat this directory as a first-run setup guide.
- Do not run cleanup or reset scripts on shared environments unless the script is explicitly part of the approved runbook.
- Do not add new one-time markdown runbooks here. Prefer steady-state docs under `docs/reference/operations/` and keep one-off execution detail in the PR that introduces it.
