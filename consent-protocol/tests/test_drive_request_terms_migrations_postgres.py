"""Migrations 311 (requester estimate) and 312 (review asks) on real PostgreSQL.

UAT replays every migration on every deploy with a short lock timeout, so a
replay must change nothing and never wait behind live writers. 312 widens the
Drive event vocabulary and the Feed allowlist without dropping a type that a
later migration added. Rollbacks keep evidence: estimates and delivered asks.
"""

# ruff: noqa: F811 -- imported isolated PostgreSQL fixtures

from __future__ import annotations

import json
import re
from pathlib import Path
from uuid import uuid4

import pytest
from psycopg2 import errors as pg_errors
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from db.migration_authority import _replay_sql, build_manifest_entries
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

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "db" / "migrations"
QUOTE = "311_drive_request_initial_quote.sql"
REVIEW = "312_drive_request_review_requests.sql"
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

    assert [rejected("initial_quote_cents", cents) for cents in (50, 150, 50100)] == [True] * 3
    assert [rejected("initial_quote_cents", cents) for cents in (None, 100, 50000)] == [False] * 3
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
    # The Feed fixture replays 246 and 288 after the shared schema; 312 follows.
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
@pytest.mark.xfail(
    strict=True,
    raises=pg_errors.CheckViolation,
    reason=(
        "288 compares the event check to an exact list and rebuilds it without "
        "document_share_review_requested on replay; the integrator must make "
        "288's replay superset-preserving (see the L10 report)."
    ),
)
async def test_replaying_288_after_312_keeps_review_asks(feed, sharing):
    _execute(sharing, _sql(REVIEW))
    _insert_event(sharing, (await request(sharing))["requestId"])
    [entry] = build_manifest_entries(MIGRATIONS, ["288_drive_request_feed_stream.sql"])
    _execute(sharing, _replay_sql(entry))
    assert REVIEW_EVENT in _event_types(sharing)
