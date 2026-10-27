"""Real skewed-history regression for the production Memory projection timeout.

Adapted only from tests/services/plg_postgres_queries.py at SOURCE_COMMIT; the
unrelated all-agent batching case is deliberately excluded. D8 owns the table
DDL (030/098/123) but not migrations 407/408. Their exact UTF-8/LF SQL bytes and
SHA-256 digests below are TEST FIXTURES from db/migrations/ at SOURCE_COMMIT,
not deployed migrations or permission to modify an existing database.

Select: pytest -q tests/test_plg_memory_query_postgres.py
Set ONE_COMMAND_TEST_DATABASE_URL to a disposable localhost PostgreSQL admin
service. This case owns one UUID-named database and drops it even on failure.
"""

import asyncio
import hashlib
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

from hushh_mcp.services import plg_outcomes as outcomes
from hushh_mcp.services.pkm_mutation_contracts import derive_pkm_mutation_commit_id

pytestmark = pytest.mark.db
ROOT = Path(__file__).resolve().parents[1]
INDEX = "idx_pkm_events_plg_memory_revision"
SOURCE_COMMIT = "f5feaf84a878f63d1dd47263f3dc12fc14d0d3c1"

# Keys are exact canonical source paths relative to db/migrations/.
MIGRATION_FIXTURES = {
    "407_plg_memory_revision_index.sql": (
        "3249bf736f03c4f107063250ca9120c5ddb5f289b9fdbd01bd9e1cff5be46e7e",
        """-- migration: transactional=false
-- Equality lookup for the existing owner-confirmed Memory outcome projection.
-- Keep text revision semantics, duplicate audit events and all outcome filters.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pkm_events_plg_memory_revision
  ON public.pkm_events (user_id, domain, (metadata->>'data_version'))
  WHERE operation_type = 'content_write'
    AND metadata->'provenance'->>'authorization_mode' = 'owner_confirmed'
    AND NULLIF(BTRIM(metadata->'provenance'->>'mutation_plan_id'), '') IS NOT NULL
    AND NULLIF(BTRIM(metadata->'provenance'->>'confirmation_receipt_id'), '') IS NOT NULL;
""",
    ),
    "408_validate_plg_memory_revision_index.sql": (
        "2a2404ad9c0a3ea180754ee4c6add94114109da71a606f96c68b4b018b601264",
        """BEGIN;

-- Parse the expected definition on this PostgreSQL version, without touching
-- live rows. Inherit the indexed columns' installed types and collations without
-- creating a new persistent identity shape or copying rows, guards or indexes.
-- Comparing only the name or indisvalid would accept a wrong index.
CREATE TEMPORARY TABLE plg_memory_index_contract (
  LIKE public.pkm_events
) ON COMMIT DROP;
CREATE INDEX plg_memory_expected_index
  ON plg_memory_index_contract (user_id, domain, (metadata->>'data_version'))
  WHERE operation_type = 'content_write'
    AND metadata->'provenance'->>'authorization_mode' = 'owner_confirmed'
    AND NULLIF(BTRIM(metadata->'provenance'->>'mutation_plan_id'), '') IS NOT NULL
    AND NULLIF(BTRIM(metadata->'provenance'->>'confirmation_receipt_id'), '') IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index actual
    JOIN pg_catalog.pg_class relation ON relation.oid = actual.indexrelid
    JOIN pg_catalog.pg_am method ON method.oid = relation.relam
    CROSS JOIN pg_catalog.pg_index expected
    WHERE actual.indexrelid = to_regclass('public.idx_pkm_events_plg_memory_revision')
      AND actual.indrelid = 'public.pkm_events'::regclass
      AND expected.indexrelid = 'pg_temp.plg_memory_expected_index'::regclass
      AND method.amname = 'btree' AND relation.relkind = 'i'
      AND actual.indisvalid AND actual.indisready AND actual.indislive
      AND NOT actual.indisunique AND NOT actual.indisexclusion
      AND actual.indnkeyatts = 3 AND actual.indnatts = 3
      AND actual.indclass = expected.indclass
      AND actual.indcollation = expected.indcollation
      AND actual.indoption = expected.indoption
      AND pg_get_indexdef(actual.indexrelid, 1, false) = pg_get_indexdef(expected.indexrelid, 1, false)
      AND pg_get_indexdef(actual.indexrelid, 2, false) = pg_get_indexdef(expected.indexrelid, 2, false)
      AND pg_get_indexdef(actual.indexrelid, 3, false) = pg_get_indexdef(expected.indexrelid, 3, false)
      AND pg_get_expr(actual.indpred, actual.indrelid, false)
        = pg_get_expr(expected.indpred, expected.indrelid, false)
  ) THEN
    RAISE EXCEPTION 'PLG Memory index missing, invalid or incompatible; inspect and rebuild migration 407 before retrying 408';
  END IF;
END;
$$;
COMMIT;
""",
    ),
    "rollback/407_plg_memory_revision_index.rollback.sql": (
        "6d9f15c0be2e2ef0961108ab16e28ff27c76acce55d14753e45c16d242db33d6",
        """-- Run outside a transaction, after stopping overlapping migration runners.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_pkm_events_plg_memory_revision;
""",
    ),
    "rollback/408_validate_plg_memory_revision_index.rollback.sql": (
        "9afd93a23ae9fd572d961e9ce9363b04e999eee69b576854979e4abdc2e5f376",
        """-- Validation persists no relation or customer changes. Roll back 407 explicitly
-- if its compatible performance index must be removed.
SELECT 1;
""",
    ),
}


def _sql(name):
    if name in MIGRATION_FIXTURES:
        digest, source = MIGRATION_FIXTURES[name]
        assert hashlib.sha256(source.encode("utf-8")).hexdigest() == digest
        return source
    return (ROOT / "db/migrations" / name).read_text(encoding="utf-8")


def test_memory_revision_lookup_on_disposable_postgres():
    configured = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not configured:
        pytest.skip("Canonical disposable PostgreSQL administrator URL is required")
    url = make_url(configured)
    # Never follow libpq query overrides or a non-loopback production endpoint.
    # CI's canonical administrator URL targets its disposable local service.
    assert url.get_backend_name() == "postgresql", "PostgreSQL test URL is required"
    assert url.host in {"localhost", "127.0.0.1", "::1"} and not url.query, (
        "Disposable administrator URL must use loopback with no query overrides"
    )
    url = url.set(drivername="postgresql+psycopg2")
    database = "plg_memory_index_" + uuid4().hex
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    engine = None
    created = False
    try:
        with admin.connect() as conn:
            conn.exec_driver_sql(f'CREATE DATABASE "{database}"')
        created = True
        engine = create_engine(url.set(database=database), isolation_level="AUTOCOMMIT")
        with engine.connect() as conn:
            _bootstrap_schema(conn)
        asyncio.run(_exercise(url.set(database=database)))
        with engine.connect() as conn:
            _verify_index_contract(conn)
    finally:
        if engine is not None:
            engine.dispose()
        try:
            if created:
                with admin.connect() as conn:
                    conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
        finally:
            admin.dispose()


def _bootstrap_schema(conn):
    conn.exec_driver_sql("CREATE TABLE pkm_domain_revisions(revision_id UUID PRIMARY KEY)")
    for filename, table in [
        ("030_pkm_cutover.sql", "pkm_events"),
        ("098_pkm_v7_recovery_foundation.sql", "pkm_domain_commits"),
    ]:
        source = _sql(filename)
        table_sql = re.search(rf"CREATE TABLE IF NOT EXISTS {table} \(.*?\n\);", source, re.S)
        assert table_sql
        conn.exec_driver_sql(table_sql.group())
        lookup = re.search(rf"CREATE INDEX IF NOT EXISTS idx_{table}_lookup\s+.*?;", source, re.S)
        assert lookup
        conn.exec_driver_sql(lookup.group())
    sync = re.search(
        r"CREATE INDEX IF NOT EXISTS idx_pkm_events_device_sync\s+.*?;",
        _sql("123_pkm_device_sync.sql"),
        re.S,
    )
    assert sync
    conn.exec_driver_sql(sync.group())


def _verify_index_contract(conn):
    # A valid but wrong same-named index must not pass IF NOT EXISTS.
    conn.exec_driver_sql(_sql("rollback/407_plg_memory_revision_index.rollback.sql"))
    for definition in [
        "ON pkm_events(domain,user_id)",
        "ON pkm_events(user_id,domain,(metadata->>'data_version'))",
    ]:
        conn.exec_driver_sql(f"CREATE INDEX {INDEX} {definition}")
        conn.exec_driver_sql(_sql("407_plg_memory_revision_index.sql"))
        with pytest.raises(Exception, match="PLG Memory index missing, invalid or incompatible"):
            conn.exec_driver_sql(_sql("408_validate_plg_memory_revision_index.sql"))
        conn.exec_driver_sql("ROLLBACK")
        conn.exec_driver_sql(_sql("rollback/407_plg_memory_revision_index.rollback.sql"))
    # Simulate an interrupted concurrent build in this disposable DB.
    conn.exec_driver_sql(_sql("407_plg_memory_revision_index.sql"))
    conn.exec_driver_sql(
        f"UPDATE pg_catalog.pg_index SET indisvalid=false WHERE indexrelid='{INDEX}'::regclass"
    )
    conn.exec_driver_sql(_sql("407_plg_memory_revision_index.sql"))
    with pytest.raises(Exception, match="PLG Memory index missing, invalid or incompatible"):
        conn.exec_driver_sql(_sql("408_validate_plg_memory_revision_index.sql"))
    conn.exec_driver_sql("ROLLBACK")
    conn.exec_driver_sql(_sql("rollback/407_plg_memory_revision_index.rollback.sql"))
    conn.exec_driver_sql(_sql("407_plg_memory_revision_index.sql"))
    for _ in range(2):
        conn.exec_driver_sql(_sql("407_plg_memory_revision_index.sql"))
        conn.exec_driver_sql(_sql("408_validate_plg_memory_revision_index.sql"))
    conn.exec_driver_sql(_sql("rollback/408_validate_plg_memory_revision_index.rollback.sql"))
    conn.exec_driver_sql(_sql("rollback/407_plg_memory_revision_index.rollback.sql"))


async def _exercise(url):
    import asyncpg

    conn = await asyncpg.connect(
        url.set(drivername="postgresql").render_as_string(hide_password=False)
    )
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=7)
    owners = ["skewed-owner", "other-owner", *[f"empty-owner-{i}" for i in range(23)]]
    try:
        await _seed_history(conn, now)
        await _seed_witnesses(conn, owners, now)
        await _seed_excluded(conn)
        await conn.execute("ANALYZE pkm_events; ANALYZE pkm_domain_commits")
        query = (
            "SELECT owners.user_id AS _plg_user_id,effect.* FROM unnest($1::text[]) "
            "AS owners(user_id) CROSS JOIN LATERAL ("
            + outcomes.MEMORY_SQL.replace("LIMIT 101", "LIMIT 1001").replace("$1", "owners.user_id")
            + ") AS effect"
        )
        # The missing-index negative control measures scanned work, not a flaky
        # wall-clock assertion. Run only one probe commit on the old plan.
        probe = """EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT id FROM pkm_events WHERE user_id=$1 AND domain='personal'
            AND metadata->>'data_version'='1'
            AND operation_type='content_write'
            AND metadata->'provenance'->>'authorization_mode'='owner_confirmed'
            AND NULLIF(BTRIM(metadata->'provenance'->>'mutation_plan_id'),'') IS NOT NULL
            AND NULLIF(BTRIM(metadata->'provenance'->>'confirmation_receipt_id'),'') IS NOT NULL"""
        before = json.loads(await conn.fetchval(probe, owners[0]))[0]["Plan"]
        assert _visited(before) > 50000
        await conn.execute(_sql("407_plg_memory_revision_index.sql"))
        await conn.execute(_sql("408_validate_plg_memory_revision_index.sql"))
        await conn.execute("ANALYZE pkm_events")
        after = json.loads(await conn.fetchval(probe, owners[0]))[0]["Plan"]
        assert _visited(after) < 20 and INDEX in json.dumps(after)
        await conn.execute("SET statement_timeout='5s'")
        for mode in ["force_custom_plan", "force_generic_plan"]:
            await conn.execute(f"SET plan_cache_mode='{mode}'")
            rows = await conn.fetch(query, owners, since, now, timeout=5)
            assert len(rows) == 1005
            assert sum(row["_plg_user_id"] == owners[0] for row in rows) == 1001
            # Preserve distinct provenance rows before the existing effect
            # deduplication. An inner LIMIT 1 would lose these witnesses.
            assert sum(row["_plg_user_id"] == owners[1] for row in rows) == 4
            assert all(row["plan_id"] != "pkm_wrong_abcdefgh" for row in rows)
            expected = {
                uid: await outcomes.value_summary(
                    conn, uid, "agent_personal_information", since, now
                )
                for uid in owners[:2]
            }
            actual = await outcomes.value_summaries(
                conn, owners, "agent_personal_information", since, now
            )
            assert actual[owners[0]] == expected[owners[0]]
            assert actual[owners[0]]["count"] == 1000 and actual[owners[0]]["limited"]
            assert actual[owners[1]] == expected[owners[1]] and actual[owners[1]]["count"] == 2
            assert all(actual[uid]["count"] == 0 for uid in owners[2:])
    finally:
        await conn.close()


async def _seed_history(conn, now):
    # One owner has many historical events in the SAME domain. An owner-only
    # or owner/domain index still scans those events for every commit.
    await conn.execute(
        """
      INSERT INTO pkm_events(user_id,domain,operation_type,metadata,created_at)
      SELECT 'skewed-owner','personal','content_write',
        jsonb_build_object('data_version',n::text,'provenance',jsonb_build_object(
          'authorization_mode','owner_confirmed','mutation_plan_id','pkm_historical_abcdefgh',
          'confirmation_receipt_id','historical-receipt')), $1::timestamptz-INTERVAL '30 days'
      FROM generate_series(10000,60000) AS history(n)
    """,
        now,
    )
    await conn.execute("""
      INSERT INTO pkm_events(user_id,domain,operation_type,metadata)
      SELECT 'unrelated-'||(n%100),'personal','content_write',
        jsonb_build_object('data_version',n::text) FROM generate_series(1,50000) AS other(n)
    """)


async def _seed_witnesses(conn, owners, now):
    commits, events = [], []
    for owner, count in [(owners[0], 1002), (owners[1], 2)]:
        for n in range(1, count + 1):
            plan = f"pkm_plan_{owner.replace('-', '_')}_{n:06d}"
            commit = derive_pkm_mutation_commit_id(user_id=owner, domain="personal", plan_id=plan)
            commits.append((commit, owner, n, now - timedelta(seconds=n)))
            metadata = {
                "data_version": str(n),
                "provenance": {
                    "authorization_mode": "owner_confirmed",
                    "mutation_plan_id": plan,
                    "confirmation_receipt_id": "receipt",
                    "writer_id": "fixture",
                },
            }
            events.append((owner, "content_write", json.dumps(metadata)))
            # Duplicate audit events are legitimate; neither counts twice.
            events.append((owner, "content_write", json.dumps(metadata)))
            if owner == owners[1]:
                metadata["provenance"]["writer_id"] = "another-fixture-writer"
                events.append((owner, "content_write", json.dumps(metadata)))
    await conn.executemany(
        """
      INSERT INTO pkm_domain_commits(commit_id,user_id,domain,commit_kind,
        expected_content_revision,expected_manifest_revision,result_content_revision,
        result_manifest_revision,created_at) VALUES($1,$2,'personal','mutation',0,0,$3,1,$4)
    """,
        commits,
    )
    await conn.executemany(
        """
      INSERT INTO pkm_events(user_id,domain,operation_type,metadata)
      VALUES($1,'personal',$2,$3::jsonb)
    """,
        events,
    )


async def _seed_excluded(conn):
    # These share revision 1 but fail the exact outcome predicate. Text
    # version '01' and nonnumeric metadata must never be cast into a match.
    excluded = [
        {
            "data_version": value,
            "provenance": {
                "authorization_mode": mode,
                "mutation_plan_id": plan,
                "confirmation_receipt_id": receipt,
            },
        }
        for value, mode, plan, receipt in [
            ("1", "background", "pkm_wrong_abcdefgh", "receipt"),
            ("1", "owner_confirmed", " ", "receipt"),
            ("1", "owner_confirmed", "pkm_wrong_abcdefgh", " "),
            ("01", "owner_confirmed", "pkm_wrong_abcdefgh", "receipt"),
            ("not-an-integer", "owner_confirmed", "pkm_wrong_abcdefgh", "receipt"),
        ]
    ]
    await conn.executemany(
        """INSERT INTO pkm_events(user_id,domain,operation_type,metadata)
      VALUES('skewed-owner','personal','content_write',$1::jsonb)""",
        [(json.dumps(row),) for row in excluded],
    )


def _visited(plan):
    return max(
        [plan.get("Actual Rows", 0) + plan.get("Rows Removed by Filter", 0)]
        + [_visited(child) for child in plan.get("Plans", [])]
    )
