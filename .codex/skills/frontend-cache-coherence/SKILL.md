---
name: frontend-cache-coherence
description: Use when auditing or changing Hussh frontend cache-first screen behavior, warm-cache UX, stale-while-revalidate resources, route TTL policy, or reviewer-backed cache coherence checks.
---

# Hussh Frontend Cache Coherence Skill

## Purpose and Trigger

- Primary scope: `frontend-cache-coherence`
- Trigger on cache-first screen UX, route TTL policy, stale-while-revalidate resources, warm-cache audits, and reviewer-backed cache checks.
- Avoid overlap with `frontend-architecture`, `frontend-native-surface-mapper`, and `vault-pkm-governance`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `frontend`

Owned repo surfaces:

1. `hushh-webapp/lib/cache`
2. `hushh-webapp/lib/services/cache-service.ts`
3. `hushh-webapp/lib/cache/cache-sync-service.ts`
4. `hushh-webapp/scripts/architecture/audit-cache-coherence.mjs`
5. `hushh-webapp/cache-coherence-screen-manifest.generated.json`
6. `docs/reference/architecture/cache-coherence.md`
7. `docs/reference/quality/app-surface-design-system.md`

Non-owned surfaces:

1. `frontend`
2. `frontend-architecture`
3. `frontend-native-surface-mapper`
4. `vault-pkm-governance`

## Do Use

1. Screen-level cache posture audits and warm-cache UX fixes.
2. Resource hooks, TTL policy, background refresh, and cache invalidation contract work.
3. Reviewer-backed checks proving protected routes do not block on loaders when cache is warm.

## Do Not Use

1. Broad route inventory or package-script ownership; use `frontend-architecture`.
2. Route/API/native/plugin mapping; use `frontend-native-surface-mapper`.
3. PKM protocol, vault key, or encrypted storage boundary changes; use `vault-pkm-governance`.

## Read First

1. `docs/reference/architecture/cache-coherence.md`
2. `docs/reference/quality/app-surface-design-system.md`
3. `hushh-webapp/cache-coherence-screen-manifest.generated.json`
4. `hushh-webapp/scripts/testing/verify-signed-in-routes.mjs`
5. `hushh-webapp/lib/cache/use-stale-resource.ts`

## Workflow

1. Classify the prompt claim as existing, partial, missing, future-state, wrong-direction, or needs-verification.
2. Run the cache and manifest checks before trusting screen coverage.
3. Preserve the security posture: decrypted PKM, vault keys, and consent secrets stay memory-only.
4. Use `useStaleResource` or a service-owned resource wrapper for warm-cache rendering.
5. Route all mutation invalidation through `CacheSyncService` or a domain service that delegates to it.
6. Use reviewer env identity only through the existing resolver; never hardcode reviewer values.

## Handoff Rules

1. If route inventory, package scripts, or generated surface-map shape changes, hand off to `frontend-architecture`.
2. If native parity or API dependency mapping changes, hand off to `frontend-native-surface-mapper`.
3. If PKM/vault persistence semantics change, hand off to `vault-pkm-governance`.
4. If browser proof policy changes, hand off to `quality-contracts`.

## Required Checks

```bash
cd hushh-webapp && npm run verify:cache
cd hushh-webapp && npm run audit:cache-coherence
cd hushh-webapp && npm run verify:surface-map
cd hushh-webapp && npm run verify:service-boundary
```
