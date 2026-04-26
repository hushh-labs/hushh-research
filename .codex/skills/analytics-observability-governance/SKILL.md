---
name: analytics-observability-governance
description: Use when changing or verifying Kai analytics observability across GA4, Firebase Analytics, BigQuery export, growth dashboard contracts, property and stream topology, or shared-auth versus analytics-plane boundaries.
---

# Hussh Analytics Observability Governance Skill

## Purpose and Trigger

- Primary scope: `analytics-observability-governance-intake`
- Trigger on GA4/Firebase/BigQuery observability workflows, growth dashboard verification, property or stream topology inspection, key-event and custom-dimension governance, shared-auth versus analytics-plane reasoning, and observability doc upkeep.
- Avoid overlap with `repo-operations`, `docs-governance`, and `quality-contracts`.

## Coverage and Ownership

- Role: `owner`
- Owner family: `analytics-observability-governance`

Owned repo surfaces:

1. `docs/reference/operations/observability-architecture-map.md`
2. `docs/reference/operations/observability-google-first.md`
3. `docs/reference/operations/observability-event-matrix.md`
4. `docs/reference/quality/analytics-verification-contract.md`
5. `hushh-webapp/lib/observability`
6. `hushh-webapp/__tests__/services/observability-schema.test.ts`
7. `hushh-webapp/__tests__/services/observability-route-map.test.ts`
8. `hushh-webapp/__tests__/services/observability-growth.test.ts`
9. `hushh-webapp/__tests__/services/observability-native-firebase.test.ts`
10. `hushh-webapp/__tests__/services/observability-web-transport.test.ts`
11. `hushh-webapp/__tests__/services/observability-sandbox-audit.test.ts`
12. `hushh-webapp/scripts/testing/run-observability-sandbox-audit.mjs`
13. `hushh-webapp/scripts/testing/run-uat-analytics-smoke.mjs`
14. `consent-protocol/scripts/observability`
15. `.codex/skills/analytics-observability-governance`

Non-owned surfaces:

1. `repo-operations`
2. `docs-governance`
3. `frontend`
4. `mobile-native`
5. `backend`

## Do Use

1. Inspecting GA4 properties, Firebase app streams, or BigQuery export links.
2. Governing key events, custom dimensions, and growth dashboard query contracts.
3. Explaining or verifying shared-auth versus analytics-sink separation across UAT and production.
4. Updating the observability docs set and relationship diagrams as the system evolves.
5. Verifying that dashboards and query surfaces match the emitted event contract.

## Do Not Use

1. Generic deploy, Cloud Run, branch-protection, or CI ownership work.
2. Documentation-home placement decisions outside the observability doc family.
3. Broad frontend or backend product implementation that is not primarily about observability.

## Read First

1. `docs/reference/operations/observability-architecture-map.md`
2. `docs/reference/operations/observability-google-first.md`
3. `docs/reference/operations/observability-event-matrix.md`
4. `docs/reference/quality/analytics-verification-contract.md`
5. `.codex/skills/analytics-observability-governance/references/property-stream-dataset-matrix.md`
6. `.codex/skills/analytics-observability-governance/references/event-taxonomy-and-validation.md`
7. `consent-protocol/scripts/observability/ga4_growth_dashboard_queries.sql`

## Workflow

1. Inspect the live topology first; do not trust stale screenshots or assumed property mappings.
2. Treat the analytics system as three planes: identity, analytics collection, and reporting.
3. Keep production as the canonical business-reporting surface and UAT as validation-only unless the policy changes explicitly.
4. Update property/stream/dataset references, event taxonomy, and verification docs in the same change.
5. Keep BigQuery query ownership explicit and exclude non-Kai streams such as `HushhVoice` from Kai growth models.
6. Verify repo-side schema and transport behavior with `npm run verify:analytics` before treating any property-side change as complete.
7. Run `npm run audit:analytics-sandbox` for local transport proof and `npm run verify:analytics:governed` for the full deployed validation bundle when UAT can be exercised.
8. Use the local inspection helper for non-mutating inventory and drift checks before editing docs or dashboard assumptions.
9. Keep the all-routes route-ID test strict; first-party app routes must not map to `unknown`.
10. UAT analytics smoke must reuse the existing reviewer test fixture through `REVIEWER_UID` and `REVIEWER_VAULT_PASSPHRASE`; `UAT_SMOKE_*` and `KAI_TEST_*` are temporary migration aliases only.
11. If the smoke fixture is missing portfolio or recommendation state, repair or reseed that same fixture rather than minting another account.
12. After the cold `/login` boot, Playwright analytics smoke must use Next client navigation for protected route transitions so the in-memory vault key is preserved.
13. Web observability must push `dataLayer` for GTM compatibility and send direct GA4 `gtag` events to the configured measurement ID; do not let GTM trigger drift be the only path for governed KPI events.
14. UAT smoke must verify direct GA4 collect handoff for required web events in addition to client-side `dataLayer` capture.
15. Spawn subagents only for independent, bounded, non-blocking lanes such as read-only route coverage audits, docs/skill updates, or disjoint verification automation patches; keep the immediate critical-path task local.

## Handoff Rules

1. If the task becomes generic deploy or environment rollout work, use `repo-operations`.
2. If the task becomes documentation-home governance outside observability, use `docs-governance`.
3. If the task becomes frontend route or UI implementation beyond observability emitters, use `frontend`.
4. If the task becomes native plugin or mobile build parity work, use `mobile-native`.
5. If the task becomes backend runtime instrumentation beyond the observability-owned script surface, use `backend`.

## Required Checks

```bash
python3 -m py_compile .codex/skills/analytics-observability-governance/scripts/inspect_analytics_surface.py
python3 .codex/skills/analytics-observability-governance/scripts/inspect_analytics_surface.py validate
python3 .codex/skills/analytics-observability-governance/scripts/inspect_analytics_surface.py health
cd hushh-webapp && npm run verify:analytics
cd hushh-webapp && npm run audit:analytics-sandbox
cd hushh-webapp && npm run smoke:analytics:uat
cd hushh-webapp && npm run verify:analytics:governed
./bin/hushh docs verify
```
