# UAT Apple iOS-First Final Verification

Status: Not complete.

This file will be filled after the shared-system migration and rendered route checks are complete.

## Visual Context

Canonical visual owner: [Quality and Design System Index](../reference/quality/README.md).

This file is the visual evidence ledger for the migration. It stays incomplete until every in-scope route has rendered proof across the required responsive and state matrix.

## Current State

- Route inventory exists: `docs/ui-migration/route-matrix.md`.
- Phase 1 visual audit exists: `docs/ui-migration/visual-audit.md`.
- Agent theme registry audit exists: `docs/ui-migration/agent-theme-registry.md`.
- Responsive verification matrix exists: `docs/ui-migration/responsive-test-matrix.md`.
- Hierarchy audit exists: `docs/ui-migration/hierarchy-audit.md`.
- Shared typography role primitives have been added.
- `PageHeader`, `SectionHeader`, `SettingsGroup`, `SettingsRow`, shared field primitives, base `Button`, top shell tabs, breadcrumbs, and Morphy typography constants have been normalized to the shared role classes.
- `npm run typecheck`, `npm run verify:design-system`, `npm run verify:cache`, `npm run verify:docs`, and `npm run lint` passed after the shared-component pass.
- `npm run verify:routes` is blocked locally because the maintainer-only reviewer identity environment is missing `REVIEWER_UID` and `REVIEWER_VAULT_PASSPHRASE`.
- No UAT deployment has been performed for this hierarchy pass yet.
- No route is marked visually complete yet.

## Final Gate Checklist

| Gate | Status |
| --- | --- |
| Every in-scope route inventoried | In progress |
| Welcome remains excluded/unchanged | Needs verification |
| Every visible agent traversed | Not started |
| Shared tokens normalized | In progress |
| Shared components normalized | In progress |
| Content preserved | Needs verification |
| Forms and validation preserved | Needs verification |
| Navigation preserved | Needs verification |
| Mobile verification complete | Not started |
| Tablet verification complete | Not started |
| Desktop verification complete | Not started |
| iOS safe-area behavior verified | Not started |
| Keyboard behavior verified | Not started |
| Functional tests pass | In progress: typecheck, design-system, cache, docs, and lint passed; route rendering blocked by missing reviewer secrets |
| UAT deployment complete | Not started |
| UAT visual recheck complete | Not started |

## Notes

Do not use this file as approval to push, merge, or deploy. It is the final evidence ledger and remains incomplete until the migration has rendered proof.
