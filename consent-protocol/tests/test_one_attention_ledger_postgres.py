"""Migration 257 and the attention ledger's SQL on real PostgreSQL.

Proves what an in-memory fake cannot: the card is claimed once per source and
only within a week of the first connection; the daily push cap holds under the
real count; an undelivered push frees its slot; the opened-item lookup is
owner-bound and only for a push actually sent; rows follow the actor profile on
deletion; and the migration replays while its rollback refuses a populated
table.

Runs when ONE_COMMAND_TEST_DATABASE_URL points at an isolated PostgreSQL
database. Tables this test needs but finds missing are created as minimal
stand-ins and dropped afterwards; existing tables are only row-scoped.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

from db.db_client import DatabaseClient
from hushh_mcp.services import feed_attention_push as push
from hushh_mcp.services import first_connect_insights_service as insights
from tests.feed_fixture_support import add_followup_fence_relations

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = (ROOT / "db/migrations/258_one_attention_ledger.sql").read_text()
ROLLBACK = (ROOT / "db/migrations/rollback/258_one_attention_ledger.rollback.sql").read_text()
OWNER = "attn-owner"
OTHER = "attn-other"

_STAND_INS = {
    "actor_profiles": "CREATE TABLE actor_profiles (user_id TEXT PRIMARY KEY)",
    "feed_events": (
        "CREATE TABLE feed_events (id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL,"
        " source_domain TEXT NOT NULL, event_type TEXT NOT NULL, actor_label TEXT,"
        " metadata JSONB NOT NULL DEFAULT '{}'::jsonb, source_row_id TEXT,"
        " dismissed_at TIMESTAMPTZ, dismissal_token UUID, read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())"
    ),
    "messages": "CREATE TABLE messages(id UUID PRIMARY KEY,conversation_id UUID,sender_user_id TEXT,deleted_for_recipient_at TIMESTAMPTZ,deleted_for_everyone_at TIMESTAMPTZ)",
    "conversations": "CREATE TABLE conversations(id UUID PRIMARY KEY,participant_a_user_id TEXT,participant_b_user_id TEXT)",
    "google_provider_connections": "CREATE TABLE google_provider_connections(user_id TEXT,provider TEXT,status TEXT)",
    "gmail_personal_information_requests": "CREATE TABLE gmail_personal_information_requests(workflow_id UUID PRIMARY KEY,user_id TEXT,status TEXT,reply_send_action_id TEXT)",
    "kai_gmail_connections": (
        "CREATE TABLE kai_gmail_connections (user_id TEXT PRIMARY KEY, status TEXT,"
        " revoked BOOLEAN, connected_at TIMESTAMPTZ)"
    ),
    "google_service_grants": (
        "CREATE TABLE google_service_grants (user_id TEXT, provider TEXT, service TEXT,"
        " status TEXT, created_at TIMESTAMPTZ DEFAULT now())"
    ),
    "user_external_connector_connections": (
        "CREATE TABLE user_external_connector_connections (user_id TEXT, connector_id TEXT,"
        " status TEXT, connected_at TIMESTAMPTZ)"
    ),
}


def _postgres_url() -> str:
    url = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not url:
        pytest.skip("An isolated PostgreSQL database is required.")
    return url.replace("postgresql+psycopg2://", "postgresql://", 1)


async def _seed_attention_sources(pool):
    await pool.execute("INSERT INTO actor_profiles (user_id) VALUES ($1), ($2)", OWNER, OTHER)
    await pool.execute(
        "INSERT INTO kai_gmail_connections (user_id, status, revoked, connected_at)"
        " VALUES ($1, 'connected', false, NOW() - INTERVAL '1 day')",
        OWNER,
    )
    # Connected long before this shipped: never offered.
    await pool.execute(
        "INSERT INTO user_external_connector_connections"
        " (user_id, connector_id, status, connected_at)"
        " VALUES ($1, 'google_drive', 'connected', NOW() - INTERVAL '30 days')",
        OWNER,
    )


async def _prepare_attention_decisions(pool):
    await pool.execute(
        "INSERT INTO gmail_personal_information_requests VALUES('11111111-1111-4111-8111-111111111111',$1,'detected',NULL)",
        OWNER,
    )
    await pool.execute("UPDATE kai_gmail_connections SET status='error' WHERE user_id=$1", OWNER)
    await pool.execute(
        "INSERT INTO google_provider_connections VALUES($1,'google','needs_reauth')", OWNER
    )


def test_attention_ledger_on_postgres(monkeypatch) -> None:
    import asyncpg

    url = _postgres_url()
    engine = create_engine(make_url(url).set(drivername="postgresql+psycopg2"))
    monkeypatch.setattr("hushh_mcp.services.feed_service.get_db", lambda: DatabaseClient(engine))

    async def scenario() -> None:
        pool = await asyncpg.create_pool(url, min_size=1, max_size=4)

        async def _pool() -> Any:
            return pool

        monkeypatch.setattr("db.connection.get_pool", _pool)
        created: list[str] = []
        try:
            await pool.execute("DROP TABLE IF EXISTS one_attention_ledger")
            for table, ddl in _STAND_INS.items():
                if await pool.fetchval("SELECT to_regclass($1)", f"public.{table}") is None:
                    await pool.execute(ddl)
                    created.append(table)
            with engine.begin() as conn:
                add_followup_fence_relations(conn)
            await pool.execute(MIGRATION)
            await pool.execute(MIGRATION)  # every deploy replays it

            await _seed_attention_sources(pool)
            # --- The card: once per source, first week only ---------------------
            ledger = insights.PostgresFirstConnectLedger()
            assert await ledger.eligible_sources(OWNER) == ["gmail"]
            assert await ledger.claim(OWNER, "gmail") is True
            assert await ledger.claim(OWNER, "gmail") is False  # in flight elsewhere
            assert await ledger.eligible_sources(OWNER) == []
            await ledger.settle(OWNER, "gmail", "failed")
            assert await ledger.claim(OWNER, "gmail") is False  # retry waits an hour
            await pool.execute(
                "UPDATE one_attention_ledger SET updated_at = NOW() - INTERVAL '2 hours'"
            )
            assert await ledger.eligible_sources(OWNER) == ["gmail"]
            assert await ledger.claim(OWNER, "gmail") is True
            await ledger.settle(OWNER, "gmail", "offered")
            assert await ledger.eligible_sources(OWNER) == []
            assert await ledger.claim(OWNER, "gmail") is False  # never again

            await _prepare_attention_decisions(pool)
            # --- The push: notable only, capped per day ------------------------
            ids = [
                await pool.fetchval(
                    "INSERT INTO feed_events (user_id, source_domain, event_type, actor_label)"
                    " VALUES ($1, 'connected_systems', $2, 'Northwind Bank') RETURNING id",
                    user_id,
                    event_type,
                )
                for user_id, event_type in [
                    (OWNER, "mail_information_request_detected"),
                    (OWNER, "consent_requested"),  # has its own push
                    (OWNER, "mail_reconnect_required"),
                    (OWNER, "calendar_reconnect_required"),
                    (OTHER, "kyc_status_changed"),
                ]
            ]
            await pool.execute(
                "UPDATE feed_events SET source_row_id='11111111-1111-4111-8111-111111111111' WHERE id=$1",
                ids[0],
            )
            store = push.PostgresFeedAttentionStore()
            candidates = await store.candidates(
                event_types=sorted(push.NOTABLE_EVENT_TYPES), limit=50
            )
            assert [c.item_id for c in candidates] == [
                str(ids[0]),
                str(ids[2]),
                str(ids[3]),
                str(ids[4]),
            ]
            outcomes = [
                await store.claim(user_id=c.user_id, item_id=c.item_id, daily_cap=2)
                for c in candidates
            ]
            assert outcomes == ["sent", "sent", "throttled", "sent"]
            # Claimed once: a second instance gets nothing, the sweep sees nothing.
            assert await store.claim(user_id=OWNER, item_id=str(ids[0]), daily_cap=2) is None
            assert (
                await store.candidates(event_types=sorted(push.NOTABLE_EVENT_TYPES), limit=50) == []
            )

            # An undelivered push frees its slot for the next notable row.
            await store.settle(user_id=OWNER, item_id=str(ids[2]), outcome="no_device")
            later = await pool.fetchval(
                "INSERT INTO feed_events (user_id, source_domain, event_type)"
                " VALUES ($1, 'kai', 'kai_analysis_saved') RETURNING id",
                OWNER,
            )
            assert await store.claim(user_id=OWNER, item_id=str(later), daily_cap=2) == "sent"
            assert (
                await pool.fetchval(
                    "SELECT COUNT(*) FROM one_attention_ledger WHERE user_id = $1"
                    " AND kind = 'feed_attention_push' AND outcome = 'sent'",
                    OWNER,
                )
                == 2
            )

            # Opening: owner-bound, and only for a push actually sent.
            item = await push.get_offered_feed_item(user_id=OWNER, item_id=str(ids[0]))
            assert item is not None and item["event_type"] == "mail_information_request_detected"
            assert await push.get_offered_feed_item(user_id=OWNER, item_id=str(ids[3])) is None
            assert await push.get_offered_feed_item(user_id=OTHER, item_id=str(ids[0])) is None
            assert await push.get_offered_feed_item(user_id=OWNER, item_id=str(ids[1])) is None

            # No content column exists to leak into.
            columns = {
                row["column_name"]
                for row in await pool.fetch(
                    "SELECT column_name FROM information_schema.columns"
                    " WHERE table_name = 'one_attention_ledger'"
                )
            }
            assert columns == {
                "user_id",
                "kind",
                "subject_ref",
                "outcome",
                "created_at",
                "updated_at",
            }

            # Rows follow the actor profile on account deletion.
            await pool.execute("DELETE FROM actor_profiles WHERE user_id = $1", OTHER)
            assert (
                await pool.fetchval(
                    "SELECT COUNT(*) FROM one_attention_ledger WHERE user_id = $1", OTHER
                )
                == 0
            )

            with pytest.raises(asyncpg.RaiseError, match="rollback_refused_nonempty_table"):
                await pool.execute(ROLLBACK)
            await pool.execute("DELETE FROM one_attention_ledger")
            await pool.execute(ROLLBACK)
            assert await pool.fetchval("SELECT to_regclass('public.one_attention_ledger')") is None
        finally:
            await pool.execute("DROP TABLE IF EXISTS one_attention_ledger")
            for table in (
                "feed_events",
                "messages",
                "conversations",
                "google_provider_connections",
                "gmail_personal_information_requests",
                "kai_gmail_connections",
                "google_service_grants",
                "user_external_connector_connections",
            ):
                if table not in created:
                    continue
                await pool.execute(f"DROP TABLE IF EXISTS {table}")
            if "actor_profiles" in created:
                await pool.execute("DROP TABLE IF EXISTS actor_profiles")
            else:
                await pool.execute(
                    "DELETE FROM actor_profiles WHERE user_id = ANY($1::TEXT[])", [OWNER, OTHER]
                )
            await pool.close()
            engine.dispose()

    asyncio.run(scenario())
