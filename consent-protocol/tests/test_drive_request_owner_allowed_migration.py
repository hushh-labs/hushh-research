"""Migration 291: owner Allow column and bounded owner price.

A request from outside the owner's Trusted circle runs the automatic pipeline
only after the owner allows it, at the owner's whole-dollar price. The database
bounds that price on the live order and on the account-free obligation that
outlives erasure. Replay runs this migration on every deploy, so a replay must
change nothing and wait behind no live writer. The rollback must not strand a
retained owner-priced payment under a check that row would violate.

The PostgreSQL cases use the isolated Drive sharing fixture: each test gets a
fresh schema with the real Drive migrations. They skip locally without a
PostgreSQL server; CI supplies one.
"""

# ruff: noqa: F811 -- imported isolated PostgreSQL fixtures

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest
from psycopg2 import errors as pg_errors
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

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
MIGRATION_NAME = "291_drive_request_owner_allowed.sql"
ROLLBACK_NAME = "291_drive_request_owner_allowed.rollback.sql"
MIGRATION = (MIGRATIONS / MIGRATION_NAME).read_text(encoding="utf-8")
ROLLBACK = (MIGRATIONS / "rollback" / ROLLBACK_NAME).read_text(encoding="utf-8")
ORDERS = "drive_request_payment_orders"
OBLIGATIONS = "drive_request_payment_obligations"
# Services write these while a deploy replays its migrations.
LIVE_TABLES = ("drive_share_requests", ORDERS, OBLIGATIONS)
ACCEPTED_CENTS = (100, 2000, 50000)
REJECTED_CENTS = (50, 150, 50100)
INSERTS = {
    ORDERS: """INSERT INTO drive_request_payment_orders
      (request_id,user_id,requester_user_id,amount_cents)
      VALUES (:request,'owner','recipient',:amount)""",
    OBLIGATIONS: """INSERT INTO drive_request_payment_obligations
      (request_id,payer_ref,amount_cents,currency,status)
      VALUES (:request,:payer,:amount,'usd','awaiting_payment')""",
}


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
    """Run sql while another session holds the table locks of uncommitted writes."""
    with sharing.db.engine.connect() as writer:
        writer.exec_driver_sql(f"LOCK TABLE {','.join(LIVE_TABLES)} IN ROW EXCLUSIVE MODE")
        try:
            _execute(sharing, sql, lock_timeout_ms=500)
        finally:
            writer.rollback()


def _owner_allowed_column(sharing) -> tuple[str, bool] | None:
    with sharing.db.engine.connect() as connection:
        row = connection.execute(
            text("""SELECT format_type(atttypid,atttypmod),attnotnull FROM pg_attribute
              WHERE attrelid=CAST('drive_share_requests' AS regclass)
                AND attname='owner_allowed_at' AND NOT attisdropped""")
        ).one_or_none()
    return None if row is None else (row[0], row[1])


def _amount_checks(sharing) -> dict[str, tuple[int, str]]:
    """Every CHECK on the payment tables that mentions the amount: name -> (oid, definition)."""
    with sharing.db.engine.connect() as connection:
        rows = connection.execute(
            text("""SELECT conname,oid::bigint,pg_get_constraintdef(oid) FROM pg_constraint
              WHERE conrelid IN (CAST(:orders AS regclass),CAST(:obligations AS regclass))
                AND contype='c'"""),
            {"orders": ORDERS, "obligations": OBLIGATIONS},
        ).all()
    return {
        name: (oid, definition) for name, oid, definition in rows if "amount_cents" in definition
    }


def _rejected_by(sharing, table: str, amount: int, request_id: str) -> str | None:
    """The constraint that refuses this amount, or None. The insert is always rolled back."""
    params = {"request": request_id, "amount": amount}
    if table == OBLIGATIONS:
        params = {"request": str(uuid4()), "payer": "0" * 64, "amount": amount}
    with sharing.db.engine.connect() as connection:
        try:
            connection.execute(text(INSERTS[table]), params)
        except IntegrityError as error:
            return error.orig.diag.constraint_name
        finally:
            connection.rollback()
    return None


async def _fixed_price_request(sharing) -> str:
    """A request on 262's fixed-price schema, however far the shared fixture migrated.

    The request is created with 291 applied, so it uses the current request
    columns, and the rollback then restores the shape 291 starts from.
    """
    _execute(sharing, MIGRATION)
    created = await request(sharing)
    _execute(sharing, ROLLBACK)
    assert _owner_allowed_column(sharing) is None
    return str(created["requestId"])


def test_owner_allowed_migration_ships_with_rollback_and_schema_contracts() -> None:
    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())
    ordered = manifest["ordered_migrations"]
    assert ordered.index(MIGRATION_NAME) > ordered.index("262_drive_request_payments.sql")
    assert manifest["rollback_migrations"][MIGRATION_NAME] == f"rollback/{ROLLBACK_NAME}"
    for contract_name in (
        "prod_core_schema.json",
        "uat_integrated_schema.json",
        "dev_minimum_schema.json",
    ):
        contract = json.loads((ROOT / "db" / "contracts" / contract_name).read_text())
        assert contract["expected_migration_version"] >= 291
        assert "owner_allowed_at" in contract["required_tables"]["drive_share_requests"]


@pytest.mark.asyncio
async def test_first_apply_bounds_owner_price_and_finds_fixed_checks_by_definition(sharing):
    request_id = await _fixed_price_request(sharing)
    # A restored or hand-repaired database can carry 262's check under another name.
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text(f"""ALTER TABLE {ORDERS} RENAME CONSTRAINT
              {ORDERS}_amount_cents_check TO legacy_order_amount_check""")
        )
    assert _rejected_by(sharing, ORDERS, 2000, request_id) == "legacy_order_amount_check"
    assert (
        _rejected_by(sharing, OBLIGATIONS, 2000, request_id) == f"{OBLIGATIONS}_amount_cents_check"
    )

    _execute(sharing, MIGRATION)

    assert set(_amount_checks(sharing)) == {
        f"{ORDERS}_amount_cents_check",
        f"{OBLIGATIONS}_amount_cents_check",
    }
    for table in (ORDERS, OBLIGATIONS):
        bounded = f"{table}_amount_cents_check"
        assert [_rejected_by(sharing, table, cents, request_id) for cents in ACCEPTED_CENTS] == [
            None,
            None,
            None,
        ]
        assert [_rejected_by(sharing, table, cents, request_id) for cents in REJECTED_CENTS] == [
            bounded,
            bounded,
            bounded,
        ]
    # A Trusted request still gets the 1000-cent default; Allow time starts empty.
    with sharing.db.engine.begin() as connection:
        ordered = connection.execute(
            text("""INSERT INTO drive_request_payment_orders (request_id,user_id,requester_user_id)
              VALUES (:id,'owner','recipient') RETURNING amount_cents"""),
            {"id": request_id},
        ).scalar_one()
        retained = connection.execute(
            text("SELECT amount_cents FROM drive_request_payment_obligations WHERE request_id=:id"),
            {"id": request_id},
        ).scalar_one()
        allowed_at = connection.execute(
            text("SELECT owner_allowed_at FROM drive_share_requests WHERE request_id=:id"),
            {"id": request_id},
        ).scalar_one()
    assert (ordered, retained, allowed_at) == (1000, 1000, None)
    assert _owner_allowed_column(sharing) == ("timestamp with time zone", False)


@pytest.mark.asyncio
async def test_replay_changes_nothing_and_waits_behind_no_live_writer(sharing):
    await _fixed_price_request(sharing)
    # Negative control: the first application needs ACCESS EXCLUSIVE, so the
    # same uncommitted writes make it time out and leave the schema unchanged.
    with pytest.raises(pg_errors.LockNotAvailable):
        _while_writers_hold_rows(sharing, MIGRATION)
    assert _owner_allowed_column(sharing) is None

    _execute(sharing, MIGRATION)
    installed = _amount_checks(sharing)
    _while_writers_hold_rows(sharing, MIGRATION)

    # Same constraint OIDs: replay neither dropped nor re-added a check.
    assert _amount_checks(sharing) == installed
    assert _owner_allowed_column(sharing) == ("timestamp with time zone", False)


@pytest.mark.asyncio
async def test_rollback_refuses_while_an_owner_priced_payment_is_retained(sharing):
    _execute(sharing, MIGRATION)
    request_id = str((await request(sharing))["requestId"])
    with sharing.db.engine.begin() as connection:
        connection.execute(text(INSERTS[ORDERS]), {"request": request_id, "amount": 2000})

    with pytest.raises(pg_errors.RaiseException, match="owner-priced document payments"):
        _execute(sharing, ROLLBACK)
    # Request erasure removes the live order but retains the account-free
    # obligation for settlement. That retained $20 row still blocks.
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("DELETE FROM drive_request_payment_orders WHERE request_id=:id"),
            {"id": request_id},
        )
    with pytest.raises(pg_errors.RaiseException, match="owner-priced document payments"):
        _execute(sharing, ROLLBACK)
    assert _owner_allowed_column(sharing) is not None
    assert _rejected_by(sharing, OBLIGATIONS, 3000, request_id) is None

    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("DELETE FROM drive_request_payment_obligations WHERE request_id=:id"),
            {"id": request_id},
        )
    _execute(sharing, ROLLBACK)

    assert _owner_allowed_column(sharing) is None
    for table in (ORDERS, OBLIGATIONS):
        fixed = f"{table}_amount_cents_check"
        assert _rejected_by(sharing, table, 2000, request_id) == fixed
        assert _rejected_by(sharing, table, 1000, request_id) is None
