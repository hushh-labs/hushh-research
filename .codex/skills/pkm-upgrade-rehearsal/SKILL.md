---
name: pkm-upgrade-rehearsal
description: Use when proving zero-loss PKM upgrades with historical fixtures, reviewer rehearsals, rollback, scopes, and exact encrypted/decrypted artifacts.
---

# Hussh PKM Upgrade Rehearsal Skill

## Purpose and Trigger

- Primary scope: `pkm-upgrade-rehearsal`
- Trigger on PKM version/projection upgrades, preservation proof, reviewer payload rehearsal, quarantine, rollback, or scope-origin acceptance.
- Avoid overlap with `vault-pkm-governance`, `reviewer-app-testing`, and `data-model-audit`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `security-audit`

Owned repo surfaces:

1. `.codex/skills/pkm-upgrade-rehearsal`
2. `.codex/skills/pkm-upgrade-rehearsal/scripts/reviewer-pkm-app-rehearsal.mjs`
3. `consent-protocol/scripts/audit_active_pkm_shape_readonly.py`
4. `consent-protocol/scripts/eval_pkm_structure_agent.py`
5. `scripts/ci/pkm-upgrade-gate.sh`

Non-owned surfaces:

1. `consent-protocol/hushh_mcp/vault`
2. `hushh-webapp/scripts/testing/reviewer-test-identity.mjs`
3. `consent-protocol/db/migrations`

## Do Use

1. Historical decrypt-transform-prove-encrypt-decrypt-rollback corpora.
2. Occurrence-level preservation, equal-value deduplication, quarantine, rollback, and idempotency acceptance.
3. Reviewer brokerage plus natural confirmed-memory rehearsal and exact payload artifacts.
4. Canonical-scope stability and additive reserved/dynamic scope-origin metadata proof.

## Do Not Use

1. Generic reviewer login, BYOK, or navigation helpers; use `reviewer-app-testing`.
2. Vault encryption or ordinary PKM storage implementation; use `vault-pkm-governance`.
3. Apply migrations, deploy, reset an account, or mutate shared fixtures without separate authority.
4. Treat structure-agent output as authorization to drop or overwrite information.

## Read First

1. `.codex/skills/reviewer-app-testing/references/byok-reviewer-browser-contract.md`
2. `.codex/skills/pkm-upgrade-rehearsal/references/reviewer-pkm-upgrade-contract.md`
3. `docs/reference/architecture/pkm-cutover-runbook.md`
4. `docs/reference/architecture/pkm-storage-adr.md`
5. `consent-protocol/docs/reference/personal-knowledge-model.md`
6. `scripts/ci/pkm-upgrade-gate.sh`

## Workflow

1. Classify the target contract/version and inventory every supported stored shape and active consumer.
2. Run deterministic historical fixtures before intelligence, browser, or environment-backed checks.
3. Require occurrence lineage, type/value preservation, quarantine restoration, rollback equality, and idempotency.
4. Run the read-only active-shape audit and gated structure-agent chain without plaintext PKM in prompts.
5. Verify target-environment schema and route parity before requesting reviewer mutation authority.
6. When authorized, import the shared reviewer harness and run the app sequence without persisting keys or tokens.
7. Accept only zero preservation, scope, authorization, coherence, export, and rollback failures.

## Handoff Rules

1. BYOK and browser-session mechanics route to `reviewer-app-testing`.
2. Vault/storage implementation routes to `vault-pkm-governance`.
3. Migration governance routes to `data-model-audit`; deploy parity routes to `uat-scoped-deploy`.
4. Broad security work returns to `security-audit`.

## Required Checks

```bash
./scripts/ci/pkm-upgrade-gate.sh
./bin/hushh codex data-model-audit
./scripts/ci/reviewer-app-testing-check.sh
```
