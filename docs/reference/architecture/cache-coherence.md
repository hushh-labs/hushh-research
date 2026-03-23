# Cache Coherence Reference

## Purpose

Hushh frontend cache is **memory-only** and deterministic. Every DB-backed mutation must pass through `CacheSyncService` so all views read coherent state without stale data.

Source files:
- `hushh-webapp/lib/services/cache-service.ts`
- `hushh-webapp/lib/cache/cache-sync-service.ts`
- `hushh-webapp/lib/cache/cache-context.tsx`
- `consent-protocol/hushh_mcp/services/market_insights_cache.py`
- `consent-protocol/hushh_mcp/services/market_cache_store.py`

## Key Taxonomy

Fixed user keys:
- PKM metadata cache key for the user
- PKM encrypted blob cache key for the user
- `vault_status_${userId}`
- `vault_check_${userId}`
- `active_consents_${userId}`
- `pending_consents_${userId}`
- `consent_audit_log_${userId}`
- `portfolio_data_${userId}`

Dynamic user keys:
- `domain_data_${userId}_${domain}`
- `domain_blob_${userId}_${domain}`
- `stock_context_${userId}_${ticker}`

Summary metadata write-through fields (when available):
- `attribute_count`
- `item_count`
- `holdings_count` (financial/portfolio-like domains)
- `portfolio_total_value`

Backend Kai market cache tiers (generalized modules):
- L1 memory cache: `market_insights_cache`
- L2 Postgres cache table: `kai_market_cache_entries`
- L3 live provider fetch

## Mutation -> Cache Sync Matrix

- PKM store domain: `CacheSyncService.onPkmDomainStored(...)`
- PKM clear domain: `CacheSyncService.onPkmDomainCleared(...)`
- Portfolio upsert/save: `CacheSyncService.onPortfolioUpserted(...)`
- Vault setup/check state changes: `CacheSyncService.onVaultStateChanged(...)`
- Consent approve/deny/revoke: `CacheSyncService.onConsentMutated(...)`
- Analysis history write/delete: `CacheSyncService.onAnalysisHistoryMutated(...)`
- Sign out: `CacheSyncService.onAuthSignedOut(...)`
- Account delete: `CacheSyncService.onAccountDeleted(...)`

## Sign-out and Delete Purge Policy

- Sign-out should purge all user-scoped cache keys through `onAuthSignedOut(userId)`.
- Account delete should call `onAccountDeleted(userId)` before final sign-out/redirect.
- When user id is unavailable, full cache clear is allowed (`onAuthSignedOut(null)`).

## Rules

Do:
- Centralize invalidation/write-through in `CacheSyncService`.
- Write through encrypted blob keys when CRUD payloads already include ciphertext.
- Patch cached PKM metadata in-place when safe summary fields are provided.
- Keep `CacheContext` as state mirror only.
- Use `invalidateUser(userId)` when purging a full user session.
- Keep domain blob + metadata reconciliation aligned with PKM index semantics.

Don't:
- Add ad-hoc `CacheService.getInstance().invalidate(...)` calls in mutation flows.
- Mix component-level DB mutation and cache operations.

## Verification

Run:
- `cd hushh-webapp && npm run verify:cache`
- `cd hushh-webapp && npm run verify:capacitor:e2e`

The `verify:cache` script hard-fails when critical mutation/auth paths bypass `CacheSyncService`.

## Reconciliation Notes

- Domain metadata patches should preserve canonical summary counters (`attribute_count`, `item_count`, `holdings_count`).
- Raw `total_value` is not retained in index summary cache patches; numeric values should map to `portfolio_total_value`.
- If patch inputs are insufficient, invalidate metadata and force a clean re-fetch rather than persisting partial summaries.
