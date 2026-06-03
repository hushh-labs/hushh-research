# Frontend Cache Coherence

Use this workflow when a task touches screen-level warm-cache behavior, stale background refresh, TTL policy, cache invalidation, or reviewer-backed route cache proof.

## Goal

Every app screen declares cache posture, renders warm cached data without a blocking loader, and refreshes stale data in the background while preserving PKM/vault memory-only boundaries.

## Steps

1. Start with `frontend`, then use `frontend-cache-coherence` as the default spoke.
2. Run `cd hushh-webapp && npm run audit:cache-coherence` before trusting the screen inventory.
3. If route inventory or surface-map drift appears, hand off to `frontend-architecture` and `frontend-native-surface-mapper`.
4. For screen fixes, keep loading logic in service/resource hooks instead of page-local fetch/cache code.
5. For protected-route browser proof, resolve the reviewer through `REVIEWER_UID` and `REVIEWER_VAULT_PASSPHRASE`.
6. Record impacted screens, cache keys, TTL policy, invalidators, and verification commands.

## Common Drift Risks

1. Treating cold-entry `page.goto()` proof as same-session warm-cache proof.
2. Adding loaders that hide valid cached data.
3. Bypassing `CacheSyncService` from component mutation code.
4. Persisting decrypted PKM or vault material outside memory.
5. Forgetting to regenerate the cache manifest after adding a route.
