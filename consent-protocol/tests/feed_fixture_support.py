"""Schema pieces that hand-built Feed fixtures need beyond their migration lists."""

from __future__ import annotations

import asyncio
import json
import re
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import asyncpg
from sqlalchemy import text

from db.migration_authority import MigrationMode, apply_manifest_entries, build_manifest_entries
from hushh_mcp.services.feed_service import FeedService

ROOT = Path(__file__).resolve().parents[1]

# list_feed plans its Calendar follow-up visibility fence on every read, so these
# relations must resolve even when the fixture holds no follow-up events. Shape of
# migrations 443, 444 and 445 for the columns the fence names.
_FOLLOWUP_FENCE_DDL = """
CREATE TABLE calendar_email_followup_monitors(
  user_id TEXT, account_id TEXT, enabled BOOLEAN, notifications_enabled BOOLEAN);
CREATE TABLE calendar_email_followup_requests(
  id UUID, user_id TEXT, account_id TEXT, revision INT,
  reminder_sent_revision INT, state TEXT, suppressed_at TIMESTAMPTZ);
CREATE FUNCTION calendar_email_followup_grant_current(
  m calendar_email_followup_monitors) RETURNS BOOLEAN
  LANGUAGE sql AS 'SELECT FALSE';
"""


def add_followup_fence_relations(connection) -> None:
    connection.execute(text(_FOLLOWUP_FENCE_DDL))
    add_feed_presentation_relations(connection)


def add_feed_presentation_relations(connection) -> None:
    # Production counterpart and Circle ownership relations also fence the
    # important-incoming projection in hand-built Feed fixtures.
    connection.execute(
        text("""
      CREATE TABLE IF NOT EXISTS feed_event_counterparts (
        feed_event_id BIGINT PRIMARY KEY REFERENCES feed_events(id) ON DELETE CASCADE,
        counterpart_user_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS one_location_circles (
        id UUID PRIMARY KEY, owner_user_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS one_location_share_grants (
        id UUID PRIMARY KEY, recipient_user_id TEXT, recipient_cleared_at TIMESTAMPTZ);
      ALTER TABLE one_location_share_grants
        ADD COLUMN IF NOT EXISTS recipient_cleared_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS recipient_user_id TEXT;
    """)
    )


def apply_fixture_migrations(engine, filenames):
    async def run():
        connection = await asyncpg.connect(
            engine.url.set(drivername="postgresql").render_as_string(hide_password=False)
        )
        try:
            return await apply_manifest_entries(
                connection,
                build_manifest_entries(ROOT / "db/migrations", filenames),
                mode=MigrationMode.REPLAY,
            )
        finally:
            await connection.close()

    return asyncio.run(run())


class _SqliteFeedDb:
    """Runs FeedService's own mutation SQL on sqlite, as psycopg2 runs it on Postgres.

    sqlite has no array type, so only the ``= ANY(CAST(:ids AS BIGINT[]))``
    membership test is mapped to ``json_each``; everything else in each
    statement runs verbatim. JSON metadata is decoded on read, as psycopg2
    decodes JSONB. tests/test_feed_account_session_postgres.py runs the same
    statements on PostgreSQL.
    """

    def __init__(self, connection: sqlite3.Connection) -> None:
        self.connection = connection

    def execute_raw(self, sql: str, params: dict):
        if "FROM information_schema.columns" in sql:
            return SimpleNamespace(data=[])
        params = dict(params)
        sql = sql.replace("~*", "REGEXP")
        for name, value in list(params.items()):
            marker = f"= ANY(CAST(:{name} AS BIGINT[]))"
            if marker in sql:
                sql = sql.replace(marker, f"IN (SELECT value FROM json_each(:{name}))")
                params[name] = json.dumps(value)
        cursor = self.connection.execute(sql.replace(" ~* ", " REGEXP "), params)
        data = (
            [
                dict(zip([column[0] for column in cursor.description], row, strict=True))
                for row in cursor.fetchall()
            ]
            if cursor.description
            else []
        )
        for row in data:
            if isinstance(row.get("metadata"), str):
                row["metadata"] = json.loads(row["metadata"])
        self.connection.commit()
        return SimpleNamespace(data=data)


def _sqlite_feed(
    rows: list[tuple[int, str, str, str, dict]],
    *,
    stamp: list[str],
    payment_status: dict[str, str] | None = None,
) -> tuple[sqlite3.Connection, FeedService]:
    connection = sqlite3.connect(":memory:")
    connection.create_function("now", 0, lambda: stamp[0])
    connection.create_function(
        "regexp",
        2,
        lambda pattern, value: (
            value is not None and re.fullmatch(pattern, value, flags=re.I) is not None
        ),
    )
    connection.execute(
        "CREATE TABLE feed_events(id INTEGER PRIMARY KEY,user_id TEXT,source_domain TEXT,"
        "event_type TEXT,metadata TEXT,source_row_id TEXT,dismissed_at TEXT,dismissal_token TEXT,read_at TEXT)"
    )
    connection.executemany(
        "INSERT INTO feed_events(id,user_id,source_domain,event_type,metadata) VALUES(?,?,?,?,?)",
        [(*row[:4], json.dumps(row[4])) for row in rows],
    )
    service = FeedService()
    service._db = _SqliteFeedDb(connection)
    statuses = payment_status or {}

    def current_payment_status(_user_id: str, feed_rows: list[dict]) -> list[dict]:
        # Stands in for the read-time order status the Feed list puts on Pay rows.
        return [
            {
                **row,
                "metadata": {
                    **row["metadata"],
                    "current_payment_status": statuses.get(
                        row["metadata"].get("request_id"), "unavailable"
                    ),
                },
            }
            if row.get("event_type") == "document_share_payment_ready"
            else row
            for row in feed_rows
        ]

    service._with_drive_payment_status = current_payment_status  # type: ignore[method-assign]
    return connection, service


def _dismissed_with(connection: sqlite3.Connection, stamp: str) -> list[int]:
    return [
        row[0]
        for row in connection.execute(
            "SELECT id FROM feed_events WHERE dismissed_at = ? ORDER BY id", (stamp,)
        )
    ]


def _live_ids(connection: sqlite3.Connection, user_id: str) -> list[int]:
    return [
        row[0]
        for row in connection.execute(
            "SELECT id FROM feed_events WHERE user_id = ? AND dismissed_at IS NULL ORDER BY id",
            (user_id,),
        )
    ]


def install_location_publication(engine):
    """Use the accepted real audit projector and first-publication migration."""
    from pathlib import Path

    from sqlalchemy import text

    migrations = Path(__file__).resolve().parents[1] / "db/migrations"
    with engine.begin() as conn:
        conn.execute(
            text("""ALTER TABLE one_location_share_grants ADD COLUMN latest_envelope_id UUID;
          CREATE TABLE one_location_events(id BIGSERIAL PRIMARY KEY,owner_user_id TEXT,actor_user_id TEXT,
            recipient_user_id TEXT,grant_id UUID,envelope_id UUID,request_id UUID,referral_id UUID,
            event_type TEXT,metadata JSONB DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ DEFAULT now());
          CREATE INDEX idx_one_location_events_recipient_type ON one_location_events(recipient_user_id,event_type);
          CREATE TABLE one_location_envelopes(id UUID PRIMARY KEY,grant_id UUID,owner_user_id TEXT,recipient_user_id TEXT);
          CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY);
          CREATE TABLE actor_identity_cache(user_id TEXT PRIMARY KEY,display_name TEXT,photo_url TEXT,custom_photo_url TEXT,phone_number TEXT);
          CREATE FUNCTION install_account_deletion_write_guards() RETURNS void LANGUAGE sql AS 'SELECT';
          CREATE UNIQUE INDEX uq_feed_events_source_projection ON feed_events(user_id,source_domain,event_type,source_row_id) WHERE source_row_id IS NOT NULL;
        """)
        )
        for name in (
            "152_feed_events_recipient_fanout.sql",
            "186_feed_share_kind_projection.sql",
            "202_feed_counterpart_identity.sql",
            "204_feed_counterpart_indexed_lookup.sql",
            "458_location_feed_confirmed_incidents.sql",
        ):
            conn.exec_driver_sql(
                (migrations / name).read_text(), execution_options={"no_parameters": True}
            )
