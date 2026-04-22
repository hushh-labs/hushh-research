# Kai Route Audit Matrix


## Visual Context

Canonical visual owner: [Kai Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

Operational matrix for runtime audits without expanding automated test suites.

## Scope

| Route | Method | Expectation |
|---|---|---|
| `/kai/import` | `GET` | Import-first onboarding screen reachable |
| `/kai` | `GET` | Home route reachable (full/onboarding chrome by state) |
| `/kai/plaid/oauth/return` | `GET` | Plaid OAuth return page resumes Link without vault-key persistence |
| `/kai/portfolio` | `GET` | Portfolio route reachable |
| `/kai/analysis` | `GET` | Analysis route reachable |
| `/kai/optimize` | `GET` | Optimize route reachable |
| `/api/kai/voice/capability` | `GET` | Voice capability contract reachable and gated correctly for the current user/runtime |
| `/api/kai/voice/plan` | `POST` | Voice planning contract reachable with canonical planner fields plus legacy response envelope |
| `/api/kai/voice/compose` | `POST` | Post-execution voice composition contract reachable for final spoken reply generation |
| `/api/kai/voice/stt` | `POST` | Voice STT contract reachable for non-realtime fallback paths |
| `/api/kai/voice/tts` | `POST` | Voice TTS contract reachable for explicit synthesized playback |
| `/api/kai/plaid/status/{user_id}` | `GET` | Plaid aggregate status and source metadata available |
| `/api/kai/plaid/oauth/resume` | `POST` | OAuth resume session can mint a fresh Link continuation |
| `/api/kai/plaid/exchange-public-token` | `POST` | Public-token exchange syncs read-only holdings + transactions |
| `/api/kai/plaid/refresh` | `POST` | Refresh run queueing works for supported Items |
| `/api/kai/plaid/webhook` | `POST` | Webhook receiver is reachable for holdings/item health updates |
| `/api/kai/portfolio/import/stream` | `POST` | Route exists; protected stream contract available |
| `/api/kai/portfolio/analyze-losers/stream` | `POST` | Route exists; protected stream contract available |
| `/api/kai/market/insights/{user_id}` | `GET` | Strict token gate, cache-backed v2 payload |
| `/api/kai/analyze/stream` | `GET` | Strict token gate, final decision guaranteed |
| `/api/kai/chat` | `POST` | Route exists and respects token/consent checks |
| `/api/tickers/search` | `GET` | Enriched ticker metadata available |
| `/api/tickers/all` | `GET` | Universe export available |

## Runtime Audit

Use this matrix as a manual verification guide against your local or hosted stack.
Check OpenAPI for backend route presence, then visit the listed web routes directly in the browser.

## Pass Criteria

1. OpenAPI route presence for all required paths/methods.
2. Runtime probes return non-terminal status (no unresolved route failures).
3. Any degraded provider/module is explicitly labeled in API payload metadata.

## Feature Parity Audit Targets

In addition to route reachability, review these runtime behaviors:

1. Stream envelope consumption parity (import/optimize/analyze).
2. Token guard and one-refresh retry behavior for protected Kai routes.
3. Cache-first `/kai` refresh behavior within fresh TTL windows.
4. Onboarding chrome gating and command bar visibility during onboarding/import.
5. Bottom chrome scroll hide/reveal behavior on mobile-sized viewports.
6. Voice route family reachability, capability gating, and planner/compose contract health.
