# Kai Change Impact Matrix


## Visual Context

Canonical visual owner: [Kai Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

Use this matrix before merge/release to identify blast radius and compatibility risks.

## Matrix

| Subsystem | Primary Files | Contracted Outputs | Break Signals | Rollback Strategy |
| --- | --- | --- | --- | --- |
| Kai market home | `consent-protocol/api/routes/kai/market_insights.py`, `hushh-webapp/components/kai/views/kai-market-preview-view.tsx` | `/api/kai/market/insights/{user_id}` v2 envelope (`hero/watchlist/movers/sector_rotation/news_tape/signals/meta`) | missing cards, repeated provider fan-out, stale badges wrong | revert route payload additions and keep old fields while retaining additive compatibility |
| Import + portfolio normalization | `consent-protocol/api/routes/kai/portfolio.py`, `hushh-webapp/lib/utils/portfolio-normalize.ts` | validated holdings (`symbol_trust_tier`, `tradable`, dropped reasons) | action tokens appear as holdings (`BUY/SELL/...`), cash identifiers leak to watchlist | keep stricter drop/normalize rules and rerun reconciliation script for affected users |
| Debate stream + decision contract | `consent-protocol/api/routes/kai/stream.py`, `hushh-webapp/components/kai/debate-stream-view.tsx`, `hushh-webapp/components/kai/views/decision-card.tsx` | terminal `decision` includes short recommendation + degraded metadata + stream diagnostics | missing short card, false-zero diagnostics, stream never terminal | keep canonical envelope and terminal event guarantees; degrade instead of hard abort |
| PKM/index/registry coherence | PKM service layer + domain registry service | canonical summary counts + aligned `available_domains` + registry rows | context count drift, domains in PKM blob not in index/registry | run reconciliation path and verify with metadata/domain-data spot checks plus the brokerage audit checklist |
| Cache coherence | `hushh-webapp/lib/cache/cache-sync-service.ts`, `hushh-webapp/lib/services/cache-service.ts` | deterministic write-through/invalidation for CRUD | stale dashboard/home after mutation, repeated re-fetches | restore sync hooks in mutation paths and run `npm run verify:cache` |
| Token reliability | `hushh-webapp/lib/services/kai-token-guard.ts`, protected Kai pages | strict VAULT_OWNER with one refresh retry path | 401/403 loops on long-running streams | use token guard everywhere and retry once on auth failure |
| Ticker metadata enrichment | `consent-protocol/db/migrate.py`, `consent-protocol/hushh_mcp/services/ticker_db.py`, `consent-protocol/hushh_mcp/services/ticker_cache.py` | enriched ticker fields (`sector_primary`, `sector_tags`, `tradable`, etc.) | runtime DB column errors pre-migration | maintain legacy-schema fallback until migration is applied |
| Mobile parity | `docs/reference/mobile/capacitor-parity-audit.md`, `bash scripts/ci/docs-parity-check.sh` | canonical routes + documented native expectations | mobile routes missing, plugin method drift | fail release gate and sync route/plugin registrations |

## Contract Delta Checklist (Per PR)

- API payload additions/changes documented in `docs/reference/architecture/api-contracts.md`
- Stream event/payload changes documented in `docs/reference/streaming/streaming-contract.md`
- Type/interface deltas reflected in service typings
- Cache key additions/invalidations documented in `docs/reference/architecture/cache-coherence.md`
- PKM/domain summary changes documented in `consent-protocol/docs/reference/personal-knowledge-model.md`
- Mobile parity impacts documented in `docs/reference/kai/mobile-kai-parity-map.md`

## Migration and Data-Shape Risks

| Change | Risk | Compatibility Rule |
| --- | --- | --- |
| Ticker enrichment columns | older DB schema missing columns | keep fallback select path to legacy columns until migration applied |
| Financial summary sanitization | downstream expecting raw `total_value` key | use canonical `portfolio_total_value` in summaries |
| Holdings trust tiers | older portfolio payloads missing trust metadata | default classification rules in normalizer; do not assume field presence |

## Rollback Notes by Cluster

- Market home v2 payload: additive fields can be ignored by old clients; keep old compatibility keys (`market_overview`, `spotlights`, `themes`) during rollback.
- Debate degraded metadata: if UI regression appears, keep backend fields and feature-flag rendering in frontend.
- PKM summary normalization: never roll back sanitization; rollback by adding compatibility read logic, not by storing sensitive summary fields.
- Token guard: if route-level regressions occur, keep strict token policy and patch refresh sequencing only.

## Release Gate Dependencies

Required green checks before release:
- `cd hushh-webapp && npm run typecheck`
- `./bin/hushh native ios --mode uat`
- `./bin/hushh native android --mode uat`
- `npm run verify:cache`
- `npm run verify:docs`
- `bash scripts/verify-pre-launch.sh`
