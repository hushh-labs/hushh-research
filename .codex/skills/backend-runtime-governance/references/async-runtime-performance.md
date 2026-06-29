# Async Runtime Performance And Caching Health Check

Use this reference when a backend surface is slow, intermittently "unreachable",
or stalls multiple unrelated endpoints at once. It encodes the verified
event-loop-blocking diagnosis, the offload fix pattern, and the caching strategy
that maximizes throughput on the FastAPI/asyncio runtime.

## When This Reference Applies

1. A page or client reports an endpoint as slow or "not reachable" while the DB,
   Cloud SQL proxy, and pool are provably healthy.
2. Several unrelated endpoints get slow at the same time (the cascade tell).
3. Latency grows with concurrency even though each query is individually fast.
4. You are adding or reviewing any call into the synchronous DB client, an
   external SDK, or any blocking I/O from an `async def` handler.

## The #1 Latency Trap: Blocking The Event Loop

The backend runs on a single asyncio event loop (FastAPI/uvicorn). Any blocking
call invoked directly inside an `async def` handler freezes the loop and
serializes every concurrent request, so unrelated endpoints all stall together.

Two blocking classes seen in this repo:

1. External SDK calls, for example `firebase_admin` auth (`firebase_auth.get_user`).
2. The synchronous SQLAlchemy + psycopg2 stack in `db/db_client.py`
   (`get_db().execute()`, `.execute_raw()`, `.table(...).execute()`).

The async asyncpg pool in `db/connection.py` (`get_pool`) is non-blocking and
safe; the synchronous `db_client` is the landmine. Both reach Cloud SQL through
the same proxy. Supabase is removed; Cloud SQL is the only datastore.

## Diagnosis: Confirm It Is The Loop, Not The DB

Run these before editing. If the DB is fast but endpoints are slow, the loop is
frozen.

```bash
# 1. Per-endpoint server timing (look for several slow at once = cascade)
#    Backend logs request.summary with duration_ms per route_template.
#    Launch backend inline for debugging (NOT the ./bin/hushh terminal wrapper,
#    which opens external Terminal.app windows):
./bin/hushh backend --mode local --reload

# 2. Prove the DB/proxy/pool are healthy (raw connect + concurrent acquires)
cd consent-protocol && python3 - <<'PY'
import asyncio, time
from db.connection import get_pool
async def main():
    pool = await get_pool()
    t = time.perf_counter()
    async def one():
        async with pool.acquire() as c:
            await c.fetchval("select 1")
    await asyncio.gather(*[one() for _ in range(25)])
    print(f"25 concurrent acquires: {time.perf_counter()-t:.2f}s")
asyncio.run(main())
PY
```

Interpretation:

- 25 concurrent acquires fast (sub-second) + endpoints slow => event loop is
  blocked by synchronous work, not the DB or the pool.
- A single slow raw connect => cold proxy/DB or orphaned proxy (see
  `branch-runtime-ops` and the project vault notes), not a loop block.

## Fix Pattern: Offload Blocking Calls

Wrap every blocking call made from async code in a worker thread. Never call the
synchronous DB client or a blocking SDK directly from an `async def`.

```python
from starlette.concurrency import run_in_threadpool  # or asyncio.to_thread

# Blocking DB reads grouped into one sync inner fn, run once off the loop:
def _read_state():
    header = get_db().table("vault_keys").select("...").eq("user_id", uid).execute()
    wrappers = get_db().table("vault_key_wrappers").select("...").execute()
    return header, wrappers

header, wrappers = await run_in_threadpool(_read_state)
```

Reference correct usage already in the codebase:

1. `consent-protocol/api/middleware.py` — `run_in_threadpool(verify_firebase_bearer, ...)`.
2. `actor_identity_service.sync_from_firebase` — `asyncio.to_thread(firebase get_user)`.
3. `vault_keys_service.get_vault_state` — reads wrapped in `run_in_threadpool`.
4. `consent_center_service._location_buckets_async` — wraps the One Location
   contributor (which hits `get_db().execute_raw`) and is awaited at every call
   site.

Rules:

1. Batch multiple blocking reads into one sync function and offload once, rather
   than offloading each call separately.
2. Add an `_async` wrapper next to a sync helper that is called from both sync
   and async contexts; convert async callers to `await` the wrapper.
3. Prefer the async asyncpg pool for new async code paths over the sync client.

## Caching Strategy: Cut Repeat Cost After The Loop Is Unblocked

Offloading removes the freeze; caching removes repeat work. Layer caches from
the hot path outward.

1. Per-request memoization: compute a value once per request and pass it down,
   instead of re-reading it inside loops (for example, location buckets fetched
   once per summary, not per surface count).
2. Process-level TTL caches for stable reads: the vault state read uses
   `VAULT_STATE_CACHE_TTL_SECONDS` (180s); reuse this pattern for
   identity/persona/consent-count reads that change rarely. Always include the
   `user_id` (and actor) in the cache key and bound the TTL.
3. Startup warm caches: seed expensive process-wide data at startup (ticker
   cache, IAM cache, token verifier prewarm, scope validator warm) so the first
   request does not pay cold cost.
4. Invalidation discipline: every cache must define its key, its TTL, and the
   write path that clears it. A stale consent/vault cache is a correctness bug,
   not just a perf nuance, so writes that change vault wrappers or consent state
   must invalidate the matching cache entry.
5. Frontend coherence: the client cache (see `frontend-cache-coherence`) must
   not paper over a backend stall; fix the loop block first, then let caches
   reduce repeat calls. Do not cache an error/timeout state into a sticky UI
   mode (this previously hid the biometric/passkey vault unlock path).

## Measurable Health-Check Targets (verified baseline)

After offloading the vault and consent blocking reads, the profile-load hot path
moved from a frozen-loop cascade to healthy concurrency:

| Endpoint | Frozen loop | Offloaded |
|---|---|---|
| `/db/vault/get` | ~11.2s | ~0.7s |
| `/api/iam/persona` | ~34s | ~1.3s |
| `/api/account/identity/refresh?force=false` | 14-30s | ~0.18s |

Use these as regression thresholds: if any of these endpoints exceeds ~2s under
single-user dev load, suspect a re-introduced blocking call on the loop.

## Handoff

1. If the slow surface is a frontend cache/coherence problem rather than a
   backend block, route to `frontend-cache-coherence`.
2. If the slowness is a UAT/CI runtime failure, start with
   `./bin/hushh codex rca --surface runtime --text`.
3. If the blocking call is consent/trust/vault policy logic, keep the offload
   here but route the policy decision to `security-audit`.
