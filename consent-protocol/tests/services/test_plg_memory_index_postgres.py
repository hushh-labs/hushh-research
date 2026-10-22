"""Real skewed-history regression for the production Memory projection timeout.

Use the canonical disposable administrator URL, never a customer database. The
fixture reuses authored tables/indexes and exercises the unchanged bound query.
"""

import asyncio
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
ROOT = Path(__file__).resolve().parents[2]
INDEX = "idx_pkm_events_plg_memory_revision"


def _sql(name):
    return (ROOT / "db/migrations" / name).read_text(encoding="utf-8")


def test_skewed_memory_page_and_index_recovery():
    configured = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not configured:
        pytest.skip("Canonical disposable PostgreSQL administrator URL is required")
    url = make_url(configured).set(drivername="postgresql+psycopg2")
    database = "plg_memory_index_" + uuid4().hex
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    engine = None
    try:
        with admin.connect() as conn:
            conn.exec_driver_sql(f'CREATE DATABASE "{database}"')
        engine = create_engine(url.set(database=database), isolation_level="AUTOCOMMIT")
        with engine.connect() as conn:
            conn.exec_driver_sql("CREATE TABLE pkm_domain_revisions(revision_id UUID PRIMARY KEY)")
            for filename, table in [
                ("030_pkm_cutover.sql", "pkm_events"),
                ("098_pkm_v7_recovery_foundation.sql", "pkm_domain_commits"),
            ]:
                source = _sql(filename)
                table_sql = re.search(
                    rf"CREATE TABLE IF NOT EXISTS {table} \(.*?\n\);", source, re.S
                )
                assert table_sql
                conn.exec_driver_sql(table_sql.group())
                lookup = re.search(
                    rf"CREATE INDEX IF NOT EXISTS idx_{table}_lookup\s+.*?;", source, re.S
                )
                assert lookup
                conn.exec_driver_sql(lookup.group())
            sync = re.search(
                r"CREATE INDEX IF NOT EXISTS idx_pkm_events_device_sync\s+.*?;",
                _sql("123_pkm_device_sync.sql"),
                re.S,
            )
            assert sync
            conn.exec_driver_sql(sync.group())
        asyncio.run(_exercise(url.set(database=database)))
        with engine.connect() as conn:
            # A valid but wrong same-named index must not pass IF NOT EXISTS.
            conn.exec_driver_sql(_sql("rollback/407_plg_memory_revision_index.rollback.sql"))
            for definition in [
                "ON pkm_events(domain,user_id)",
                "ON pkm_events(user_id,domain,(metadata->>'data_version'))",
            ]:
                conn.exec_driver_sql(f"CREATE INDEX {INDEX} {definition}")
                conn.exec_driver_sql(_sql("407_plg_memory_revision_index.sql"))
                with pytest.raises(
                    Exception, match="PLG Memory index missing, invalid or incompatible"
                ):
                    conn.exec_driver_sql(_sql("408_validate_plg_memory_revision_index.sql"))
                conn.exec_driver_sql("ROLLBACK")
                conn.exec_driver_sql(_sql("rollback/407_plg_memory_revision_index.rollback.sql"))
            # Simulate an interrupted concurrent build in this disposable DB.
            conn.exec_driver_sql(_sql("407_plg_memory_revision_index.sql"))
            conn.exec_driver_sql(
                f"UPDATE pg_catalog.pg_index SET indisvalid=false WHERE indexrelid='{INDEX}'::regclass"
            )
            conn.exec_driver_sql(_sql("407_plg_memory_revision_index.sql"))
            with pytest.raises(
                Exception, match="PLG Memory index missing, invalid or incompatible"
            ):
                conn.exec_driver_sql(_sql("408_validate_plg_memory_revision_index.sql"))
            conn.exec_driver_sql("ROLLBACK")
            conn.exec_driver_sql(_sql("rollback/407_plg_memory_revision_index.rollback.sql"))
            conn.exec_driver_sql(_sql("407_plg_memory_revision_index.sql"))
            for _ in range(2):
                conn.exec_driver_sql(_sql("407_plg_memory_revision_index.sql"))
                conn.exec_driver_sql(_sql("408_validate_plg_memory_revision_index.sql"))
            conn.exec_driver_sql(
                _sql("rollback/408_validate_plg_memory_revision_index.rollback.sql")
            )
            conn.exec_driver_sql(_sql("rollback/407_plg_memory_revision_index.rollback.sql"))
    finally:
        if engine is not None:
            engine.dispose()
        with admin.connect() as conn:
            conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
        admin.dispose()


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
