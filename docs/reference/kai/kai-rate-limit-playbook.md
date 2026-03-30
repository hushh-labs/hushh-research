# Kai Rate-Limit Playbook


## Visual Context

Canonical visual owner: [Kai Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Provider Strategy
- Primary market/news providers are rate-limited and plan-dependent.
- Kai uses cooldown-aware fallback order and stale cache serving.

## Current Runtime Controls
- `/api/kai/market/insights/{user_id}`
  - L1 memory cache + L2 Postgres cache for generalized modules
  - stale-on-error behavior before provider retry storms
  - provider cooldown metadata exposed in `meta.provider_cooldowns`
- Fetcher cooldown short-circuit for PMP/FMP after repeated `401/402/403/429/404`.

## Cache Policy
- Fresh window: `180s` for Kai home modules.
- Stale window: `900s` for graceful degraded serving.
- Background refresh loop runs periodically but cache-first and lock-guarded.

## Operational Guidance
- If provider quota is exhausted, keep serving stale with degraded badge.
- Avoid manual forced refresh loops while `provider_cooldowns` are active.
- Review logs for repeated endpoint fallback chains and adjust cooldowns before changing fanout.
