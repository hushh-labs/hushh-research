# Cache Coherence Reference


## Visual Map

```mermaid
flowchart TB
  subgraph runtime["Client runtime"]
    ui["UI hooks / resources"]
    mem["Memory L1<br/>CacheService"]
    coordinator["PkmWriteCoordinator"]
    sync["CacheSyncService"]
  end

  subgraph device["Device persistence"]
    secure["Encrypted IndexedDB<br/>secure resource cache"]
    plain["Plain IndexedDB<br/>non-sensitive resource cache"]
  end

  subgraph backend["Backend"]
    pkm["PKM routes and services"]
    market["Market / consent / RIA APIs"]
  end

  subgraph boundary["Security invariants"]
    key["Vault key<br/>memory-only"]
    plaintext["Decrypted PKM<br/>memory-only"]
  end

  ui --> mem
  mem --> secure
  mem --> plain
  mem --> pkm
  mem --> market
  pkm --> mem
  market --> mem
  pkm --> secure
  market --> plain
  coordinator --> pkm
  coordinator --> sync
  sync --> mem
  sync --> secure
  sync --> plain
  key --> secure
  plaintext --> mem
```

## Purpose

Hushh frontend cache is split by sensitivity and runtime role:

- decrypted PKM stays **memory-only**
- encrypted PKM-derived snapshots can persist in **encrypted IndexedDB**
- non-sensitive read models can use resource-specific memory/device caches

Every DB-backed mutation must still pass through `CacheSyncService` so views stay coherent without ad-hoc invalidation.

Source files:
- `hushh-webapp/lib/services/cache-service.ts`
- `hushh-webapp/lib/cache/cache-sync-service.ts`
- `hushh-webapp/lib/cache/cache-context.tsx`
- `hushh-webapp/lib/services/secure-resource-cache-service.ts`
- `hushh-webapp/lib/pkm/pkm-domain-resource.ts`
- `hushh-webapp/lib/services/pkm-write-coordinator.ts`
- `consent-protocol/hushh_mcp/services/market_insights_cache.py`
- `consent-protocol/hushh_mcp/services/market_cache_store.py`

## Key Taxonomy

Fixed user keys:
- PKM metadata cache key for the user
- PKM encrypted blob cache key for the user
- encrypted secure-resource cache entries for PKM-derived resources
- `vault_status_${userId}`
- `vault_check_${userId}`
- `active_consents_${userId}`
- `pending_consents_${userId}`
- `consent_audit_log_${userId}`
- `consent_center_summary_${userId}_${actor}`
- `portfolio_data_${userId}`

Dynamic user keys:
- `domain_data_${userId}_${domain}`
- `domain_blob_${userId}_${domain}`
- `stock_context_${userId}_${ticker}`
- `consent_center_list_${userId}_${actor}_${surface}_${query}_${page}_${limit}`
- `consent_center_preview_${userId}_${actor}_${surface}_${top}` for dedicated preview-only callers that explicitly choose `top=n`; first-party shield inbox flows should prefer the shared `consent_center_list_*_pending_*_1_20` cache entry

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

## Sign-out And Delete Purge Policy

- Sign-out should purge all user-scoped cache keys through `onAuthSignedOut(userId)`.
- Account delete should call `onAccountDeleted(userId)` before final sign-out/redirect.
- When user id is unavailable, full cache clear is allowed (`onAuthSignedOut(null)`).

## Rules

Do:
- Centralize invalidation/write-through in `CacheSyncService`.
- Write through encrypted blob keys when CRUD payloads already include ciphertext.
- Patch cached PKM metadata in-place when safe summary fields are provided.
- Keep `CacheContext` as a state mirror only.
- Use `invalidateUser(userId)` when purging a full user session.
- Keep domain blob + metadata reconciliation aligned with PKM index semantics.
- Keep consent-manager summary/list caches memory-only.
- Keep the first-party consent inbox on the same memory-only `pending page 1` list cache used by `/consents`; do not introduce a second browser cache lane just for the top-shell preview.
- Keep BYOK/ZK boundaries explicit:
  - vault key stays memory-only
  - `VAULT_OWNER` stays memory-only
  - decrypted PKM stays memory-only
  - only ciphertext may persist to encrypted IndexedDB

Don't:
- Add ad-hoc `CacheService.getInstance().invalidate(...)` calls in mutation flows.
- Mix component-level DB mutation and cache operations.
- Reintroduce plaintext browser persistence for PKM-derived user data.

## Verification

Run:
- `cd hushh-webapp && npm run verify:cache`
- `cd hushh-webapp && npm run verify:capacitor:e2e`

The `verify:cache` script hard-fails when critical mutation/auth paths bypass `CacheSyncService`.

## Reconciliation Notes

- Domain metadata patches should preserve canonical summary counters (`attribute_count`, `item_count`, `holdings_count`).
- Raw `total_value` is not retained in index summary cache patches; numeric values should map to `portfolio_total_value`.
- If patch inputs are insufficient, invalidate metadata and force a clean re-fetch rather than persisting partial summaries.
- PKM writes are version-aware:
  - `POST /api/pkm/store-domain` remains canonical
  - first-party writes should use `PkmWriteCoordinator`
  - stale domains can trigger resumable client-side PKM upgrade before save
  - bounded optimistic conflict retries rebuild writes from the latest decrypted domain state
- Debate/analysis history writes attach explicit non-sensitive `write_projections[]`:
  - encrypted `financial.analysis_history` stays canonical
  - backend `decision_projection` events stay aligned with the encrypted history after save, refresh, and hard reload
  - first-party readers should treat `projection_mode=replace_all` as canonical for upgraded users
  - current retention stays `3` saved analyses per ticker (newest first)
- Save compatibility policy:
  - first-party financial/profile/portfolio/history writes must go through `PkmWriteCoordinator`
  - stale manifests/domains should resume the client-side PKM upgrade before save when the vault is unlocked
  - if the vault is locked and the domain is stale, the UI should surface an upgrade-required/read-only state instead of attempting a legacy plaintext fallback
