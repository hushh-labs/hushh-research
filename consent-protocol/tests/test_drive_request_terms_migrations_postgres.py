"""Drive request terms and no-charge quote replay on real PostgreSQL.

UAT replays every migration on every deploy with a short lock timeout, so a
replay must change nothing and never wait behind live writers. 321 widens the
Drive event vocabulary and the Feed allowlist without dropping a type that a
later migration added. Rollbacks keep evidence: estimates and delivered asks.
"""

# ruff: noqa: F811 -- imported isolated PostgreSQL fixtures

from __future__ import annotations

import hashlib
import json
import re
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

import pytest
from psycopg2 import connect
from psycopg2.errors import CheckViolation
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from db.migration_authority import MigrationAuthorityError, _replay_sql, build_manifest_entries
from tests.services.test_drive_feed_projection import feed, feed_rows  # noqa: F401
from tests.services.test_drive_live_query import store  # noqa: F401
from tests.services.test_drive_sharing_store import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    request,
    sharing,
)
from tests.test_migration_authority import referral_replay_postgres  # noqa: F401

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "db" / "migrations"
QUOTE = "320_drive_request_initial_quote.sql"
REVIEW = "321_drive_request_review_requests.sql"
REVIEW_EVENT = "document_share_review_requested"
LIVE_TABLES = ("drive_share_requests", "drive_share_events")


def _sql(name: str, *, rollback: bool = False) -> str:
    path = (
        MIGRATIONS / "rollback" / name.replace(".sql", ".rollback.sql")
        if rollback
        else MIGRATIONS / name
    )
    return path.read_text(encoding="utf-8")


def _execute(sharing, sql: str, *, lock_timeout_ms: int | None = None) -> None:
    """Run one migration body as replay does: a single multi-statement script."""
    with sharing.db.engine.connect() as connection:
        raw = connection.connection.driver_connection
        with raw.cursor() as cursor:
            if lock_timeout_ms is not None:
                cursor.execute(f"SET LOCAL lock_timeout = '{lock_timeout_ms}ms'")
            cursor.execute(sql)
        raw.commit()


def _while_writers_hold_rows(sharing, sql: str) -> None:
    with sharing.db.engine.connect() as writer:
        writer.exec_driver_sql(f"LOCK TABLE {','.join(LIVE_TABLES)} IN ROW EXCLUSIVE MODE")
        try:
            _execute(sharing, sql, lock_timeout_ms=500)
        finally:
            writer.rollback()


def _event_types(sharing) -> list[str]:
    with sharing.db.engine.connect() as connection:
        definition = connection.execute(
            text("""SELECT pg_get_constraintdef(oid) FROM pg_constraint
              WHERE conrelid=CAST('drive_share_events' AS regclass)
                AND conname='drive_share_events_event_type_check'""")
        ).scalar_one()
    return sorted(set(re.findall(r"'(document_share_[^']+)'", definition)))


def _request_columns(sharing) -> set[str]:
    with sharing.db.engine.connect() as connection:
        return {
            name
            for (name,) in connection.execute(
                text("""SELECT attname FROM pg_attribute
                  WHERE attrelid=CAST('drive_share_requests' AS regclass)
                    AND attnum>0 AND NOT attisdropped""")
            )
        }


def _insert_event(sharing, request_id: str, user_id: str = "owner") -> None:
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_share_events(event_id,request_id,user_id,revision,event_type)
              SELECT :id,:request,:user,COALESCE(MAX(revision)+1,0),'document_share_review_requested'
              FROM drive_share_events WHERE request_id=:request"""),
            {"id": str(uuid4()), "request": request_id, "user": user_id},
        )


def test_migrations_ship_after_the_event_vocabulary_with_rollbacks() -> None:
    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())
    ordered = manifest["ordered_migrations"]
    assert (
        ordered.index("288_drive_request_feed_stream.sql")
        < ordered.index("293_drive_request_owner_pricing.sql")
        < ordered.index(QUOTE)
        < ordered.index(REVIEW)
    )
    for name in (QUOTE, REVIEW):
        rollback = name.replace(".sql", ".rollback.sql")
        assert manifest["rollback_migrations"][name] == f"rollback/{rollback}"


@pytest.mark.asyncio
async def test_replay_changes_nothing_and_waits_for_no_live_writer(sharing):
    created = await request(sharing)
    _insert_event(sharing, created["requestId"])
    before = (_request_columns(sharing), _event_types(sharing))
    assert {"initial_quote_cents", "review_requested_at", "review_request_count"} <= before[0]
    assert REVIEW_EVENT in before[1]
    for name in (QUOTE, REVIEW, QUOTE, REVIEW):
        _while_writers_hold_rows(sharing, _sql(name))
    assert (_request_columns(sharing), _event_types(sharing)) == before


@pytest.mark.asyncio
async def test_estimates_and_ask_counts_are_bounded(sharing):
    request_id = (await request(sharing))["requestId"]

    def rejected(column: str, value: int | None) -> bool:
        with sharing.db.engine.connect() as connection:
            try:
                connection.execute(
                    text(f"UPDATE drive_share_requests SET {column}=:value WHERE request_id=:id"),
                    {"value": value, "id": request_id},
                )
            except IntegrityError:
                return True
            finally:
                connection.rollback()
        return False

    assert [rejected("initial_quote_cents", cents) for cents in (0, 49, 50001)] == [True] * 3
    assert [rejected("initial_quote_cents", cents) for cents in (None, 50, 150, 50000)] == [
        False
    ] * 4
    assert [rejected("review_request_count", n) for n in (-1, 4)] == [True, True]
    assert [rejected("review_request_count", n) for n in (0, 3)] == [False, False]


@pytest.mark.asyncio
async def test_review_vocabulary_is_widened_never_narrowed_and_rollback_keeps_history(sharing):
    later = "document_share_later_kind"
    kept = [item for item in _event_types(sharing) if item != REVIEW_EVENT]
    # A later migration's type is installed and this one is not yet.
    literals = ",".join(f"'{item}'" for item in [*kept, later])
    _execute(
        sharing,
        "ALTER TABLE drive_share_events DROP CONSTRAINT drive_share_events_event_type_check;"
        "ALTER TABLE drive_share_events ADD CONSTRAINT drive_share_events_event_type_check"
        f" CHECK (event_type IN ({literals}));",
    )
    _execute(sharing, _sql(REVIEW))
    assert _event_types(sharing) == sorted([*kept, later, REVIEW_EVENT])

    request_id = (await request(sharing))["requestId"]
    _insert_event(sharing, request_id)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests SET initial_quote_cents=2500,
              review_request_count=1 WHERE request_id=:id"""),
            {"id": request_id},
        )
    _execute(sharing, _sql(REVIEW, rollback=True))
    _execute(sharing, _sql(QUOTE, rollback=True))
    columns = _request_columns(sharing)
    assert "review_request_count" not in columns and "review_requested_at" not in columns
    # The estimate a requester saw and the delivered ask both survive rollback.
    assert "initial_quote_cents" in columns and REVIEW_EVENT in _event_types(sharing)
    _insert_event(sharing, request_id)
    with sharing.db.engine.connect() as connection:
        assert connection.execute(
            text("""SELECT initial_quote_cents,(SELECT count(*) FROM drive_share_events
              WHERE request_id=:id AND event_type='document_share_review_requested')
              FROM drive_share_requests WHERE request_id=:id"""),
            {"id": request_id},
        ).one() == (2500, 2)
    for name in (QUOTE, REVIEW, REVIEW):
        _execute(sharing, _sql(name))
    with sharing.db.engine.connect() as connection:
        assert connection.execute(
            text("""SELECT review_request_count,review_requested_at FROM drive_share_requests
              WHERE request_id=:id"""),
            {"id": request_id},
        ).one() == (0, None)


@pytest.mark.asyncio
async def test_a_review_ask_reaches_the_owner_feed(feed, sharing):
    # The Feed fixture replays 246 and 288 after the shared schema; 321 follows.
    _execute(sharing, _sql(REVIEW))
    _execute(sharing, _sql(REVIEW))
    created = await request(sharing)
    _insert_event(sharing, created["requestId"])
    asked = feed_rows(feed.db, "owner")[-1]
    assert asked["event_type"] == REVIEW_EVENT
    assert asked["counterpart_user_id"] == "recipient"
    assert asked["metadata"] == {
        "request_id": created["requestId"],
        "counterpart_label": "Bo",
        "user_facing_status": "pending",
    }


@pytest.mark.asyncio
async def test_replaying_288_after_321_keeps_review_asks(feed, sharing):
    # 288 compares the event CHECK to an exact list; its checksum-pinned replay
    # adapter must keep installed vocabulary, or every deploy after the first
    # review ask fails at 288 with a CheckViolation.
    _execute(sharing, _sql(REVIEW))
    _insert_event(sharing, (await request(sharing))["requestId"])
    [entry] = build_manifest_entries(MIGRATIONS, ["288_drive_request_feed_stream.sql"])
    _execute(sharing, _replay_sql(entry))
    assert REVIEW_EVENT in _event_types(sharing)


def _nocharge_state(sharing):
    with sharing.db.engine.connect() as connection:
        rows = connection.execute(
            text("""SELECT request_id,status,payment_required,quoted_amount_cents,
              quote_version,existing_access_waived_at FROM drive_share_requests
              ORDER BY request_id""")
        ).all()
        checks = connection.execute(
            text("""SELECT conname,pg_get_constraintdef(oid),convalidated
              FROM pg_constraint WHERE conrelid='drive_share_requests'::regclass
                AND conname IN ('drive_share_requests_locked_quote_check',
                  'drive_request_existing_access_waiver_check') ORDER BY conname""")
        ).all()
    return rows, checks


async def _completed_nocharge_quote(sharing):
    request_id = (await request(sharing))["requestId"]
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests SET status='completed',
              payment_required=FALSE,quoted_amount_cents=50,quote_version=0,
              existing_access_waived_at=clock_timestamp() WHERE request_id=:id"""),
            {"id": request_id},
        )


@pytest.mark.asyncio
async def test_cent_price_replay_preserves_completed_nocharge_quotes(sharing):
    await _completed_nocharge_quote(sharing)
    before = _nocharge_state(sharing)
    [entry] = build_manifest_entries(MIGRATIONS, ["329_drive_request_cent_prices.sql"])
    # Negative control: the published predecessor rejects a real retained quote
    # before 368 can run. Its immutable source must not be rewritten to fix replay.
    with pytest.raises(CheckViolation):
        _execute(sharing, entry.sql)
    assert _nocharge_state(sharing) == before
    for _ in range(2):
        _while_writers_hold_rows(sharing, _replay_sql(entry))
    assert _nocharge_state(sharing) == before
    # Replaying the successor too keeps the same record and money rules.
    _execute(sharing, _sql("368_drive_existing_access_nocharge.sql"))
    _execute(sharing, _replay_sql(entry))
    assert _nocharge_state(sharing) == before
    for update in (
        "existing_access_waived_at=NULL",
        "payment_required=TRUE",
        "quoted_amount_cents=49",
        "quote_version=-1",
    ):
        with pytest.raises(IntegrityError), sharing.db.engine.begin() as connection:
            connection.exec_driver_sql(f"UPDATE drive_share_requests SET {update}")


@pytest.mark.asyncio
@pytest.mark.parametrize("drift", ["grouping", "unvalidated", "column_type", "default"])
async def test_cent_price_replay_refuses_unreviewed_waiver_successors(sharing, drift):
    await _completed_nocharge_quote(sharing)
    if drift == "grouping":
        # Same tokens after stripping parentheses, different Boolean meaning.
        _execute(
            sharing,
            "ALTER TABLE drive_share_requests DROP CONSTRAINT drive_share_requests_locked_quote_check;"
            "ALTER TABLE drive_share_requests ADD CONSTRAINT drive_share_requests_locked_quote_check"
            " CHECK (quoted_amount_cents IS NULL AND quote_version IS NULL OR"
            " payment_required=TRUE OR existing_access_waived_at IS NOT NULL AND"
            " quoted_amount_cents BETWEEN 50 AND 50000 AND quote_version>=0);",
        )
    elif drift == "unvalidated":
        _execute(
            sharing,
            "ALTER TABLE drive_share_requests DROP CONSTRAINT drive_request_existing_access_waiver_check;"
            "ALTER TABLE drive_share_requests ADD CONSTRAINT drive_request_existing_access_waiver_check"
            " CHECK (existing_access_waived_at IS NULL OR payment_required=FALSE) NOT VALID;",
        )
    elif drift == "column_type":
        _execute(
            sharing,
            "ALTER TABLE drive_share_requests ALTER COLUMN existing_access_waived_at"
            " TYPE TEXT USING existing_access_waived_at::text;",
        )
    else:
        _execute(
            sharing,
            "ALTER TABLE drive_share_requests ALTER COLUMN existing_access_waived_at"
            " SET DEFAULT clock_timestamp();",
        )
    before = _nocharge_state(sharing)
    [entry] = build_manifest_entries(MIGRATIONS, ["329_drive_request_cent_prices.sql"])
    with pytest.raises(CheckViolation):
        _execute(sharing, _replay_sql(entry))
    assert _nocharge_state(sharing) == before


RETIREMENT = "360_uat_drive_collection_retirement.sql"


def _retirement_schema(connection, *, successor=True):
    connection.autocommit = True
    with connection.cursor() as cursor:
        cursor.execute("""
          CREATE TABLE drive_collection_sync(processing_enabled BOOLEAN,revision INTEGER,
            lease_id UUID,lease_expires_at TIMESTAMPTZ,updated_at TIMESTAMPTZ);
          CREATE TABLE connected_documents(source_profile TEXT,processing_enabled BOOLEAN,
            processing_revision INTEGER,lease_id UUID,lease_expires_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ);
          CREATE TABLE drive_packet_heads(packet_id UUID PRIMARY KEY,user_id TEXT);
          CREATE TABLE drive_packet_versions(packet_id UUID,user_id TEXT,available BOOLEAN,
            manifest_envelope JSONB DEFAULT '{"synthetic":"retained"}',digest TEXT DEFAULT 'synthetic');
          CREATE TABLE drive_packet_listings(packet_id UUID,user_id TEXT,enabled BOOLEAN,
            revision INTEGER,updated_at TIMESTAMPTZ);
          CREATE TABLE drive_owner_search_jobs(job_id UUID PRIMARY KEY);
          INSERT INTO drive_collection_sync VALUES(TRUE,2,gen_random_uuid(),now(),now());
          INSERT INTO connected_documents VALUES
            ('live',TRUE,3,gen_random_uuid(),now(),now()),
            ('picker',TRUE,4,NULL,NULL,now());
          INSERT INTO drive_packet_heads SELECT
            ('00000000-0000-0000-0000-00000000000'||n)::uuid,'owner'
            FROM generate_series(1,3) AS n;
          INSERT INTO drive_packet_versions(packet_id,user_id,available)
            SELECT packet_id,user_id,packet_id::text NOT LIKE '%003' FROM drive_packet_heads;
          INSERT INTO drive_packet_listings SELECT packet_id,user_id,
            packet_id::text NOT LIKE '%003',7,now() FROM drive_packet_heads;
        """)
        if successor:
            cursor.execute(_sql("411_drive_period_packets.sql"))
            cursor.execute("""UPDATE drive_packet_heads SET packet_kind='provider_discovery',
              category='financial',period_start='2026-01-01',period_end='2026-02-28',
              period_timezone='UTC' WHERE packet_id::text NOT LIKE '%001'""")


def _retirement_rows(connection):
    result = {}
    with connection.cursor() as cursor:
        for table, key in (
            ("drive_collection_sync", "revision"),
            ("connected_documents", "source_profile"),
            ("drive_packet_listings", "packet_id"),
            ("drive_packet_versions", "packet_id"),
        ):
            cursor.execute(f"SELECT row_to_json(t) FROM {table} t ORDER BY {key}")
            result[table] = [row[0] for row in cursor.fetchall()]
    return result


@pytest.mark.feature_drive_packets
@pytest.mark.trace_loop
@pytest.mark.parametrize("adapted", [False, True], ids=["published-negative-control", "replay"])
def test_retirement_replay_preserves_only_qualified_provider_packets(
    referral_replay_postgres, adapted
):
    connection, fixture_dsn = referral_replay_postgres
    _retirement_schema(connection)
    before = _retirement_rows(connection)
    [entry] = build_manifest_entries(MIGRATIONS, [RETIREMENT])
    with closing(connect(fixture_dsn)) as writer, writer.cursor() as locks:
        locks.execute("LOCK TABLE drive_packet_heads IN ROW EXCLUSIVE MODE")
        with connection.cursor() as cursor:
            cursor.execute("SET lock_timeout = '500ms'")
            cursor.execute(_replay_sql(entry) if adapted else entry.sql)
        after = _retirement_rows(connection)
        assert after["drive_collection_sync"][0]["processing_enabled"] is False
        assert after["drive_collection_sync"][0]["revision"] == 3
        assert after["drive_collection_sync"][0]["lease_id"] is None
        live, picker = after["connected_documents"]
        assert live["processing_enabled"] is False and live["processing_revision"] == 4
        assert live["lease_id"] is None and live["lease_expires_at"] is None
        assert picker == before["connected_documents"][1]
        for table, enabled in [
            ("drive_packet_listings", "enabled"),
            ("drive_packet_versions", "available"),
        ]:
            assert after[table][0][enabled] is False  # content_facts still retires.
            if adapted:
                assert (
                    after[table][1:] == before[table][1:]
                )  # Both ON and already-OFF provider rows.
            else:
                assert before[table][1][enabled] is True and after[table][1][enabled] is False
            assert after[table][2] == before[table][2]
        with connection.cursor() as cursor:
            cursor.execute(_replay_sql(entry) if adapted else entry.sql)
        assert _retirement_rows(connection) == after


@pytest.mark.feature_drive_packets
@pytest.mark.trace_loop
def test_retirement_without_period_successor_keeps_legacy_retirement(referral_replay_postgres):
    connection, _ = referral_replay_postgres
    _retirement_schema(connection, successor=False)
    [entry] = build_manifest_entries(MIGRATIONS, [RETIREMENT])
    with connection.cursor() as cursor:
        cursor.execute(_replay_sql(entry))
    after = _retirement_rows(connection)
    assert all(not row["enabled"] for row in after["drive_packet_listings"])
    assert all(not row["available"] for row in after["drive_packet_versions"])
    assert after["drive_collection_sync"][0]["processing_enabled"] is False


@pytest.mark.feature_drive_packets
@pytest.mark.trace_loop
@pytest.mark.parametrize(
    "drift", ["weak_check", "unvalidated", "kind_type", "kind_default", "nullable"]
)
def test_retirement_refuses_drifted_period_successor_before_any_writes(
    referral_replay_postgres, drift
):
    connection, _ = referral_replay_postgres
    _retirement_schema(connection)
    with connection.cursor() as cursor:
        if drift in ("weak_check", "unvalidated"):
            cursor.execute("""SELECT pg_get_constraintdef(oid) FROM pg_constraint
              WHERE conrelid='drive_packet_heads'::regclass AND conname='drive_packet_period_kind'""")
            rule = cursor.fetchone()[0]
            cursor.execute(
                "ALTER TABLE drive_packet_heads DROP CONSTRAINT drive_packet_period_kind"
            )
            cursor.execute(
                "ALTER TABLE drive_packet_heads ADD CONSTRAINT drive_packet_period_kind "
                + (
                    "CHECK (packet_kind IN ('content_facts','provider_discovery'))"
                    if drift == "weak_check"
                    else rule + " NOT VALID"
                )
            )
        else:
            cursor.execute(
                "ALTER TABLE drive_packet_heads ALTER COLUMN packet_kind "
                + {
                    "kind_type": "TYPE VARCHAR(64)",
                    "kind_default": "SET DEFAULT 'provider_discovery'",
                    "nullable": "DROP NOT NULL",
                }[drift]
            )
    before = _retirement_rows(connection)
    [entry] = build_manifest_entries(MIGRATIONS, [RETIREMENT])
    with connection.cursor() as cursor, pytest.raises(CheckViolation):
        cursor.execute(_replay_sql(entry))
    connection.rollback()
    with connection.cursor() as cursor:
        cursor.execute("ROLLBACK")  # The rejected adapter owns the original explicit BEGIN.
    assert _retirement_rows(connection) == before


@pytest.mark.feature_drive_packets
@pytest.mark.trace_loop
@pytest.mark.parametrize("drift", ["declared_checksum", "body", "rehashed_body"])
def test_retirement_replay_rejects_source_drift(drift):
    [entry] = build_manifest_entries(MIGRATIONS, [RETIREMENT])
    if drift == "declared_checksum":
        changed = replace(entry, checksum_sha256="0" * 64)
    else:
        body = entry.sql + "\n-- unreviewed body\n"
        changed = replace(
            entry,
            sql=body,
            checksum_sha256=(
                hashlib.sha256(body.encode()).hexdigest()
                if drift == "rehashed_body"
                else entry.checksum_sha256
            ),
        )
    with pytest.raises(MigrationAuthorityError):
        _replay_sql(changed)
