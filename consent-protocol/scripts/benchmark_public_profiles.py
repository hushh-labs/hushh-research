"""Synthetic PostgreSQL retrieval benchmark. Never imports real records."""

import asyncio
import hashlib
import itertools
import json
import os
import platform
import time
from pathlib import Path

import asyncpg


def percentiles(values):
    values = sorted(values)
    return {
        "samples": len(values),
        "p95_ms": round(values[int((len(values) - 1) * 0.95)], 2),
        "p99_ms": round(values[int((len(values) - 1) * 0.99)], 2),
    }


async def main():
    pool = await asyncpg.create_pool(
        os.environ["PROFILE_BENCHMARK_DSN"],
        min_size=1,
        max_size=20,
        server_settings={
            "hnsw.iterative_scan": "strict_order",
            "hnsw.ef_search": "100",
            "hnsw.max_scan_tuples": "20000",
        },
    )
    async with pool.acquire() as c:
        if not (await c.fetchval("select current_database()")).startswith("hushh_profile_fixture_"):
            raise SystemExit("Refusing a non-fixture database")
        count = await c.fetchval(
            "select count(*) from one_public_profile_entities where display_name like 'Synthetic benchmark %'"
        )
        if count < 100000:
            for start in range(0, 100000, 2000):
                await c.execute(
                    """INSERT INTO one_public_profile_entities(entity_id,display_name,prepared_payload,embedding_model,embedding)
                  SELECT md5('benchmark-'||g)::uuid,'Synthetic benchmark '||g,
                    jsonb_build_object('revision',1,'summary',repeat('Synthetic source-backed detail. ',20)),
                    'fixture:sin-768.v1',ARRAY(SELECT sin((g::float8*d)*0.001)::real FROM generate_series(1,768) d)::vector
                  FROM generate_series($1::integer,$2::integer) g ON CONFLICT(entity_id) DO NOTHING""",
                    start + 1,
                    start + 2000,
                )
                await c.execute(
                    """INSERT INTO one_public_profile_identity_anchors(entity_id,anchor_type,anchor_hash,canonical_url)
                  SELECT md5('benchmark-'||g)::uuid,'profile_url',encode(sha256(('https://example.org/benchmark/'||g)::bytea),'hex'),'https://example.org/benchmark/'||g
                  FROM generate_series($1::integer,$2::integer) g ON CONFLICT DO NOTHING""",
                    start + 1,
                    start + 2000,
                )
            await c.execute(
                "ANALYZE one_public_profile_entities; ANALYZE one_public_profile_identity_anchors"
            )
        vector = await c.fetchval(
            "select embedding::text from one_public_profile_entities where display_name='Synthetic benchmark 50000'"
        )
        version = await c.fetchval("select version()")
        size = await c.fetchval("select pg_total_relation_size('one_public_profile_entities')")

    counter = itertools.count()

    async def one(kind):
        started = time.perf_counter()
        async with pool.acquire() as c:
            if kind == "exact":
                anchor = hashlib.sha256(
                    f"https://example.org/benchmark/{((next(counter) * 7919) % 100000 + 1)}".encode()
                ).hexdigest()
                await c.fetchrow(
                    "select prepared_payload from one_public_profile_identity_anchors a join one_public_profile_entities e using(entity_id) where a.anchor_hash=$1 and a.anchor_type='profile_url'",
                    anchor,
                )
            elif kind == "text":
                await c.fetch(
                    "select entity_id from one_public_profile_entities where status='active' and search_document @@ plainto_tsquery('simple',$1) limit 20",
                    f"Synthetic benchmark {((next(counter) * 7919) % 100000 + 1)}",
                )
            else:
                await c.fetch(
                    "select entity_id from one_public_profile_entities where status='active' and prepared_payload is not null and embedding_model='fixture:sin-768.v1' order by embedding <=> $1::vector limit 20",
                    vector,
                )
        return (time.perf_counter() - started) * 1000

    metrics = {}
    for kind in ("exact", "text", "vector"):
        samples = []
        for _ in range(15):
            samples.extend(await asyncio.gather(*(one(kind) for _ in range(20))))
        metrics[kind] = percentiles(samples)

    async def ingest():
        async with pool.acquire() as c:
            for batch in range(20):
                await c.execute(
                    """INSERT INTO one_public_profile_entities(entity_id,display_name,prepared_payload,embedding_model,embedding)
                SELECT md5('interference-'||g)::uuid,'Synthetic interference '||g,'{"fixture":true}'::jsonb,'fixture:sin-768.v1',ARRAY(SELECT sin(((100000+g)::float8*d)*0.001)::real FROM generate_series(1,768) d)::vector
                FROM generate_series($1::int,$2::int) g ON CONFLICT(entity_id) DO UPDATE SET embedding=EXCLUDED.embedding,updated_at=now()""",
                    batch * 50 + 1,
                    batch * 50 + 50,
                )

    ingestion = asyncio.create_task(ingest())
    mixed = []
    for _ in range(15):
        mixed.extend(
            await asyncio.gather(*(one("exact" if n % 2 else "vector") for n in range(20)))
        )
    await ingestion
    metrics["ingestion_interference_mixed"] = percentiles(mixed)
    async with pool.acquire() as c:
        query = "select entity_id from one_public_profile_entities where status='active' and prepared_payload is not null and embedding_model='fixture:sin-768.v1' order by embedding <=> $1::vector limit 20"
        approximate = await c.fetch(query, vector)
        async with c.transaction():
            await c.execute("SET LOCAL enable_indexscan=off; SET LOCAL enable_bitmapscan=off")
            exact = await c.fetch(query, vector)
        metrics["synthetic_ann_returned_count"] = len(approximate)
        metrics["synthetic_ann_recall_at_20"] = (
            len({row["entity_id"] for row in approximate} & {row["entity_id"] for row in exact})
            / 20
        )
    # Multiple identities catch candidate starvation hidden by a single warm query.
    recalls = []
    async with pool.acquire() as c:
        for identity in (1, 7919, 15838, 23757, 31676, 39595, 50000, 63352, 79190, 99999):
            query_vector = await c.fetchval(
                "select embedding::text from one_public_profile_entities where display_name=$1",
                f"Synthetic benchmark {identity}",
            )
            approximate = await c.fetch(query, query_vector)
            async with c.transaction():
                await c.execute("SET LOCAL enable_indexscan=off; SET LOCAL enable_bitmapscan=off")
                exhaustive = await c.fetch(query, query_vector)
            recalls.append(
                len({r["entity_id"] for r in approximate} & {r["entity_id"] for r in exhaustive})
                / 20
            )
        metrics["multi_query_recall"] = {
            "queries": len(recalls),
            "minimum": min(recalls),
            "mean": sum(recalls) / len(recalls),
        }
        exact_plan = await c.fetchval(
            "EXPLAIN (FORMAT JSON) select prepared_payload from one_public_profile_identity_anchors a join one_public_profile_entities e using(entity_id) where a.anchor_hash=$1 and a.anchor_type='profile_url'",
            hashlib.sha256(b"https://example.org/benchmark/50000").hexdigest(),
        )
        text_plan = await c.fetchval(
            "EXPLAIN (FORMAT JSON) select entity_id from one_public_profile_entities where status='active' and search_document @@ plainto_tsquery('simple',$1) limit 20",
            "Synthetic benchmark 50000",
        )
    tasks = []
    started = time.perf_counter()
    for n in range(2000):
        wait = started + n / 1000 - time.perf_counter()
        if wait > 0:
            await asyncio.sleep(wait)
        tasks.append(asyncio.create_task(one("exact")))
    samples = await asyncio.gather(*tasks)
    metrics["capacity_scenario"] = {
        **percentiles(samples),
        "offered_rps": 1000,
        "duration_seconds": round(time.perf_counter() - started, 3),
    }
    async with pool.acquire() as c:
        plan = await c.fetch(
            "EXPLAIN (FORMAT JSON) select entity_id from one_public_profile_entities where status='active' and prepared_payload is not null and embedding_model='fixture:sin-768.v1' order by embedding <=> $1::vector limit 20",
            vector,
        )
    report = {
        "corpus": 100000,
        "dimensions": 768,
        "vectors": "synthetic sin; no semantic-quality claim",
        "concurrency": 20,
        "hardware": platform.platform(),
        "postgres": version,
        "entity_table_bytes": size,
        "metrics": metrics,
        "vector_query_plan": json.loads(plan[0][0]),
        "exact_query_plan": json.loads(exact_plan),
        "text_query_plan": json.loads(text_plan),
    }
    Path(
        os.environ.get("PROFILE_BENCHMARK_REPORT", "/tmp/hushh-profile-benchmark.json")
    ).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(metrics, indent=2))
    await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
