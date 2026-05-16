# Data Model Audit Playbook

## Goal

Keep the runtime database production-grade without a broad rewrite. The audit proves every migration-created table belongs to a bounded table family, has a data class and lifecycle rule, and does not revive legacy memory write paths.

## Steps

1. Read the north-star and data boundary docs:
   - `docs/project_context_map.md`
   - `docs/reference/architecture/data-model-governance.md`
   - `docs/reference/architecture/runtime-db-fact-sheet.md`
   - `docs/reference/operations/migration-governance.md`
   - `consent-protocol/docs/reference/personal-knowledge-model.md`
2. Run:
   - `./bin/hushh codex data-model-audit`
3. If a table is unclassified:
   - add it to the closest existing family in `runtime-db-data-plane-contract.json`
   - create a new family only if the table cannot honestly fit an existing bounded context
4. If a legacy write is reported:
   - remove the write path, route new writes to PKM/current tables, or explicitly keep it as a bounded migration-only exception with a removal plan
5. If a provider/cache table is added:
   - declare retention, deletion behavior, and plaintext/ciphertext posture
   - do not describe the table as durable user memory unless a consented encrypted PKM write exists
6. Re-run:
   - `python3 -m py_compile scripts/ops/data_model_audit.py`
   - `./bin/hushh codex data-model-audit`
   - `./bin/hushh codex audit`
   - `./bin/hushh docs verify`

## Production-Grade Defaults

- Keep `actor_profiles` as the long-term actor/persona parent.
- Keep `vault_keys` as vault state, not the generic user model.
- Keep provider caches short-retention and refreshable.
- Keep consent/audit/funding/trading records metadata-only and long-retention when required for accountability.
- Keep analytics truth in GA4/BigQuery, not the app DB.
