---
name: Performance Notes - Server Startup & API Latency (2026-03-31)
description: Backend performance observations from local-uatdb stack startup and marketplace API testing
type: project
---

## Server Startup Performance (local-uatdb profile)
- Backend startup: ~5s total (including ticker cache preload)
- Ticker cache: 10,556 tickers loaded in 1.61s
- DB pool: 2 connections created to Cloud SQL via proxy (min=2, max=10)
- Frontend startup: Next.js 16 ready in 216ms (webpack mode)

## API Latency Observations (Cloud SQL proxy → UAT DB)

| Endpoint | Method | Latency | Notes |
|----------|--------|---------|-------|
| `/health` | GET | 0.4ms | No DB |
| `/api/iam/marketplace/opt-in` | POST | 1359ms | Includes IAM schema readiness check + transactional upsert |
| `/api/ria/onboarding/status` | GET | 461ms | Schema check + RIA profile lookup |
| `/api/ria/marketplace/discoverability` | POST | 522ms | Transactional upsert with verification check |
| `/api/marketplace/rias` | GET | 113-175ms | Complex join across ria_profiles + marketplace_public_profiles + ria_firms |
| `/api/marketplace/investors` | GET | 171ms | Join across actor_profiles + marketplace_public_profiles |

**Why:** Network latency to Cloud SQL UAT DB is ~50-80ms per query. The `marketplace/opt-in` endpoint is slow because `_ensure_iam_schema_ready()` runs 13 table existence checks on first call.

**How to apply:**
- The IAM schema readiness check (1359ms on opt-in) should be cached more aggressively — it's already cached for 30s but the first cold call is expensive
- Marketplace search queries (113-175ms) are reasonable for the join complexity
- Consider connection pooling warmup on startup to avoid cold-start penalties

## Key Findings
1. `_ensure_iam_schema_ready()` is the biggest latency contributor — runs 13 individual `SELECT` checks. Could be reduced to a single `information_schema` query.
2. No errors or warnings in startup or API logs
3. All responses correctly return 2xx except the 404 on `/api/iam/persona-state` (incorrect endpoint path — should be `/api/iam/persona`)
4. CORS configured for single origin (localhost:3000)
5. OpenTelemetry disabled in development (no tracing overhead)
