---
name: analytics-observability-governance
description: Use when changing or verifying Kai analytics observability across GA4, Firebase Analytics, BigQuery export, growth dashboard contracts, property and stream topology, or shared-auth versus analytics-plane boundaries.
---

# Hushh Analytics Observability Governance Skill

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
6. `hushh-webapp/__tests__/services`
7. `consent-protocol/scripts/observability`
8. `.codex/skills/analytics-observability-governance`

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
7. Use the local inspection helper for non-mutating inventory and drift checks before editing docs or dashboard assumptions.

## Handoff Rules

1. If the task becomes generic deploy or environment rollout work, use `repo-operations`.
2. If the task becomes documentation-home governance outside observability, use `docs-governance`.
3. If the task becomes frontend route or UI implementation beyond observability emitters, use `frontend`.
4. If the task becomes native plugin or mobile build parity work, use `mobile-native`.
5. If the task becomes backend runtime instrumentation beyond the observability-owned script surface, use `backend`.

## Required Checks

```bash
python3 -m py_compile .codex/skills/analytics-observability-governance/scripts/inspect_analytics_surface.py
python3 .codex/skills/analytics-observability-governance/scripts/inspect_analytics_surface.py summary
python3 .codex/skills/analytics-observability-governance/scripts/inspect_analytics_surface.py validate
cd hushh-webapp && npm run verify:analytics
./bin/hushh docs verify
```
