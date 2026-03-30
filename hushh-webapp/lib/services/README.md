# Services North Star

This folder is the canonical entrypoint for platform-aware data access and route-facing service orchestration.

## Start Here

- `api-service.ts`: default web/native-aware API boundary.
- `cache-service.ts`: shared cache primitives and keys.
- `unlock-warm-orchestrator.ts`: post-unlock cache seeding and warmup.
- `kai-token-guard.ts` / related Kai services: Kai-specific protected access flow.
- `post-unlock-sync-service.ts`: post-vault-unlock background sync orchestrator (`PostUnlockSyncService`).

## Rules

1. Components do not call raw backend endpoints directly; they go through the service layer.
2. Cache policy and token-refresh behavior should be solved here, not inside route UI.
3. New service contracts must stay aligned with route contracts, mobile parity docs, and the relevant domain README.
