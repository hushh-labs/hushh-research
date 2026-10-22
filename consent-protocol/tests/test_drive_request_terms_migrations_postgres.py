"""Drive request terms and no-charge quote replay on real PostgreSQL.

UAT replays every migration on every deploy with a short lock timeout, so a
replay must change nothing and never wait behind live writers. 321 widens the
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
from psycopg2.errors import CheckViolation
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
