"""Migration 316 and the bank deposit snapshot SQL on real PostgreSQL.

Release replay runs every migration on every deploy. Migration 316 must apply
twice, wait behind no live writer once applied, and roll back without touching
deposit rows, signed event history or a stored bank snapshot. The service SQL
that orders Stripe reads, keeps the bank snapshot write-once and pages deposits
runs here as in UAT.
Skips without ONE_COMMAND_TEST_DATABASE_URL; CI supplies PostgreSQL.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import asyncpg
import psycopg2
import pytest
from psycopg2 import errors as pg_errors
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

import hushh_mcp.services.stripe_connect_balances as connect_balances
import hushh_mcp.services.stripe_connect_bank_payouts as bank_payouts
from db.migration_authority import MigrationMode, apply_manifest_entries, build_manifest_entries
from hushh_mcp.services.stripe_connect_bank_payouts import StripeConnectBankPayouts
from tests.test_stripe_connect_bank_payouts import (
    CONNECT_WEBHOOK_SECRET,
    EXAMPLE_BANK,
    PAYMENT_WEBHOOK_SECRET,
    FakeStripe,
    listed_payout,
    signed_event,
)

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "db" / "migrations"
EARLIER = ("294_drive_request_bank_payout_events.sql", "304_connect_bank_payout_reconciliation.sql")
SNAPSHOT = "316_connect_bank_payout_snapshot.sql"
MIGRATION = (MIGRATIONS / SNAPSHOT).read_text(encoding="utf-8")
ROLLBACK = (MIGRATIONS / "rollback" / "316_connect_bank_payout_snapshot.rollback.sql").read_text(
    encoding="utf-8"
)
SNAPSHOT_COLUMNS = {
    "destination_id",
    "destination_kind",
    "destination_bank_name",
    "destination_last4",
    "payout_method",
    "automatic",
    "trace_status",
    "trace_value",
    "reconciliation_status",
    "provider_observed_at",
    "status_changed_at",
    "paid_at",
    "failed_at",
}
INSERT_PAYOUT = """INSERT INTO stripe_connect_bank_payouts
  (stripe_payout_id,stripe_account_id,livemode,amount_cents,currency,status,status_rank,created_at)
  VALUES (:id,'acct_owner',FALSE,100,'usd','paid',2,:created)"""
INSERT_EVENT = """INSERT INTO stripe_connect_bank_payout_events
  (stripe_event_id,stripe_account_id,event_type,stripe_object_id,livemode)
  VALUES (:id,'acct_owner',:type,'acct_owner',FALSE)"""


@pytest.fixture
def bank_db():
    source = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not source:
        pytest.skip("An isolated PostgreSQL server is required.")
    url = make_url(source).set(drivername="postgresql+psycopg2")
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    name = "connect_bank_snapshot_" + uuid.uuid4().hex
    with admin.connect() as connection:
        connection.execute(text(f'CREATE DATABASE "{name}"'))
    engine = create_engine(url.set(database=name))
    try:
        with engine.begin() as connection:
            # Migration 298's owner mapping, without the checkout tables 298 also alters.
            connection.execute(
                text("""CREATE TABLE stripe_owner_payout_accounts (
                  user_id TEXT NOT NULL,
                  stripe_mode TEXT NOT NULL CHECK (stripe_mode IN ('test','live')),
                  stripe_account_id TEXT NOT NULL UNIQUE,
                  details_submitted BOOLEAN NOT NULL DEFAULT FALSE,
                  payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
                  account_ready BOOLEAN NOT NULL DEFAULT FALSE,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
                  PRIMARY KEY (user_id,stripe_mode))""")
            )
            connection.execute(
                text("""INSERT INTO stripe_owner_payout_accounts
                  (user_id,stripe_mode,stripe_account_id) VALUES ('owner','test','acct_owner')""")
            )
        _replay(engine, *EARLIER)
        yield engine
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
        admin.dispose()


def _replay(engine, *filenames):
    """Apply migrations exactly as the release replay does."""

    async def run():
        connection = await asyncpg.connect(
            engine.url.set(drivername="postgresql").render_as_string(hide_password=False)
        )
        try:
            return await apply_manifest_entries(
                connection,
                build_manifest_entries(MIGRATIONS, filenames),
                mode=MigrationMode.REPLAY,
            )
        finally:
            await connection.close()

    return asyncio.run(run())


def _script(engine, sql, *, lock_timeout_ms):
    """Run one migration body as a single script on its own short-lock session."""
    connection = psycopg2.connect(
        engine.url.set(drivername="postgresql").render_as_string(hide_password=False)
    )
    connection.autocommit = True
    try:
        with connection.cursor() as cursor:
            cursor.execute(f"SET lock_timeout = '{lock_timeout_ms}ms'")
            cursor.execute(sql)
    finally:
        connection.close()


def _while_writers_hold_rows(engine, sql):
    """Run sql while another session holds the table locks of uncommitted writes."""
    with engine.connect() as writer:
        writer.exec_driver_sql(
            "LOCK TABLE stripe_connect_bank_payouts,stripe_connect_bank_payout_events "
            "IN ROW EXCLUSIVE MODE"
        )
        try:
            _script(engine, sql, lock_timeout_ms=500)
        finally:
            writer.rollback()


def _snapshot_columns(engine):
    with engine.connect() as connection:
        return set(
            connection.execute(
                text("""SELECT attname FROM pg_attribute
                  WHERE attrelid=CAST('stripe_connect_bank_payouts' AS regclass)
                    AND NOT attisdropped AND attname=ANY(:names)"""),
                {"names": sorted(SNAPSHOT_COLUMNS)},
            ).scalars()
        )


def _constraints(engine):
    with engine.connect() as connection:
        return dict(
            connection.execute(
                text("""SELECT conname,oid::bigint FROM pg_constraint
                  WHERE conrelid IN (CAST('stripe_connect_bank_payouts' AS regclass),
                    CAST('stripe_connect_bank_payout_events' AS regclass))""")
            ).all()
        )


def test_snapshot_migration_replays_without_waiting_and_rolls_back_without_losing_history(
    bank_db,
):
    engine = bank_db
    # Negative control: the first application needs ACCESS EXCLUSIVE, so a live
    # writer's open transaction makes it time out and leaves the schema unchanged.
    with pytest.raises(pg_errors.LockNotAvailable):
        _while_writers_hold_rows(engine, MIGRATION)
    assert _snapshot_columns(engine) == set()

    _replay(engine, SNAPSHOT)
    installed = _constraints(engine)
    _replay(engine, SNAPSHOT)
    _while_writers_hold_rows(engine, MIGRATION)
    # Same constraint OIDs: a replay neither drops nor re-validates anything.
    assert _constraints(engine) == installed
    assert _snapshot_columns(engine) == SNAPSHOT_COLUMNS

    for column, value in (
        ("destination_id", "acct_owner"),
        ("destination_kind", "wallet"),
        ("destination_bank_name", "x" * 81),
        ("destination_last4", "12a4"),
        ("payout_method", "slow"),
        ("trace_status", "lost"),
        ("trace_value", ""),
        ("reconciliation_status", "done"),
    ):
        with pytest.raises(IntegrityError), engine.begin() as connection:
            connection.execute(text(INSERT_PAYOUT), {"id": "po_bad", "created": datetime.now(UTC)})
            connection.execute(
                text("UPDATE stripe_connect_bank_payouts SET " + column + "=:value"),
                {"value": value},
            )
    with pytest.raises(IntegrityError), engine.begin() as connection:
        connection.execute(text(INSERT_EVENT), {"id": "evt_bogus", "type": "payout.bogus"})

    with engine.begin() as connection:
        connection.execute(text(INSERT_PAYOUT), {"id": "po_kept", "created": datetime.now(UTC)})
        connection.execute(
            text("""UPDATE stripe_connect_bank_payouts SET destination_id='ba_first',
              destination_kind='bank_account',destination_bank_name='Example Bank',
              destination_last4='6789',trace_status='supported',trace_value='TRACE 0042'""")
        )
        connection.execute(
            text(INSERT_EVENT), {"id": "evt_kept", "type": "payout.reconciliation_completed"}
        )
    # Negative control: a deposit holds its bank and bank trace, which Stripe
    # cannot return once the bank is removed, so the rollback keeps them.
    _script(engine, ROLLBACK, lock_timeout_ms=5_000)
    assert _snapshot_columns(engine) == SNAPSHOT_COLUMNS
    with engine.begin() as connection:
        kept = connection.execute(
            text("""SELECT stripe_payout_id,status,amount_cents,destination_bank_name,
              destination_last4,trace_value FROM stripe_connect_bank_payouts""")
        ).all()
    assert [tuple(row) for row in kept] == [
        ("po_kept", "paid", 100, "Example Bank", "6789", "TRACE 0042")
    ]

    # An unused snapshot is dropped; deposits and the signed event history stay.
    with engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE stripe_connect_bank_payouts SET "
                + ",".join(column + "=NULL" for column in sorted(SNAPSHOT_COLUMNS))
            )
        )
    _script(engine, ROLLBACK, lock_timeout_ms=5_000)
    assert _snapshot_columns(engine) == set()
    _script(engine, ROLLBACK, lock_timeout_ms=5_000)
    with engine.begin() as connection:
        kept = connection.execute(
            text("SELECT stripe_payout_id,status,amount_cents FROM stripe_connect_bank_payouts")
        ).all()
        assert [tuple(row) for row in kept] == [("po_kept", "paid", 100)]
        # The widened event CHECK stays, so recorded events of the new types remain valid.
        connection.execute(text(INSERT_EVENT), {"id": "evt_after", "type": "balance.available"})
        events = connection.execute(
            text("SELECT stripe_event_id FROM stripe_connect_bank_payout_events ORDER BY 1")
        ).scalars()
        assert list(events) == ["evt_after", "evt_kept"]
    _replay(engine, SNAPSHOT)
    assert _snapshot_columns(engine) == SNAPSHOT_COLUMNS


def _service(engine, monkeypatch):
    for name in ("ENVIRONMENT", "HUSHH_DEPLOY_ENV", "HUSSH_DEPLOY_ENV"):
        monkeypatch.setenv(name, "uat")
    monkeypatch.setenv("STRIPE_MODE", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_" + "x" * 30)
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", PAYMENT_WEBHOOK_SECRET)
    monkeypatch.setenv("STRIPE_CONNECT_WEBHOOK_SECRET", CONNECT_WEBHOOK_SECRET)
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://uat.one.hushh.ai")
    ledger_calls = []
    monkeypatch.setattr(
        connect_balances,
        "mark_balance_refresh_due",
        lambda connection, **kwargs: ledger_calls.append(("refresh_due", kwargs)),
    )
    monkeypatch.setattr(
        connect_balances,
        "enqueue_payout_reconciliation",
        lambda connection, **kwargs: ledger_calls.append(("reconcile", kwargs)),
    )
    fake = FakeStripe()
    # The real transaction helper: PostgreSQL statement and lock timeouts apply.
    service = StripeConnectBankPayouts(db=SimpleNamespace(engine=engine), stripe_api=fake)
    return service, fake, ledger_calls


@pytest.mark.asyncio
async def test_provider_reads_snapshot_and_cursor_pages_on_postgres(bank_db, monkeypatch):
    engine = bank_db
    await asyncio.to_thread(_replay, engine, SNAPSHOT)
    service, fake, ledger_calls = _service(engine, monkeypatch)

    fake.payout_status = "in_transit"
    fake.payout_details = {"destination": "ba_first", "method": "standard", "automatic": True}
    sent = signed_event(event_id="evt_sent", kind="payout.updated")
    assert await service.process_webhook(**sent) == "updated"
    fake.payout_arrival += 2 * 86_400
    fake.payout_details = {"destination": EXAMPLE_BANK}
    moved = signed_event(event_id="evt_moved", kind="payout.updated")
    assert await service.process_webhook(**moved) == "updated"
    fake.payout_status = "paid"
    fake.payout_details = {
        "destination": {"id": "ba_first", "object": "bank_account", "deleted": True},
        "trace_id": {"status": "supported", "value": "TRACE 0042"},
        "reconciliation_status": "completed",
    }
    paid = signed_event(event_id="evt_paid", kind="payout.paid")
    assert await service.process_webhook(**paid) == "updated"
    fake.payout_status = "in_transit"  # a stale read finishing late
    stale = signed_event(event_id="evt_stale", kind="payout.updated")
    assert await service.process_webhook(**stale) == "updated"

    with engine.begin() as connection:
        observed = connection.execute(
            text("SELECT provider_observed_at FROM stripe_connect_bank_payouts")
        ).scalar_one()
        older = bank_payouts._payout_fields(
            listed_payout("po_one", status="paid"),
            payout_id="po_one",
            livemode=False,
            observed_at=observed - timedelta(seconds=1),
        )
        assert not StripeConnectBankPayouts._store_payout(
            connection, account_id="acct_owner", livemode=False, snapshot=older
        )
    payout = (await service.owner_summary(user_id="owner"))["payouts"][0]
    assert payout["status"] == "paid"
    arrival = datetime.fromtimestamp(fake.payout_arrival, UTC).isoformat()
    assert payout["expectedArrivalAt"] == arrival
    assert payout["bank"] == {"name": "Example Bank", "last4": "6789"}
    assert payout["bankReference"] == "TRACE 0042"
    assert payout["paidAt"] is not None and payout["failedAt"] is None
    assert ledger_calls == [
        ("reconcile", {"stripe_payout_id": "po_one", "stripe_account_id": "acct_owner"})
    ]

    base = datetime(2026, 10, 1, tzinfo=UTC)
    created = {f"po_{index:03d}": base + timedelta(seconds=index // 2) for index in range(24)}
    with engine.begin() as connection:
        for payout_id, at in created.items():  # pairs share a creation second
            connection.execute(text(INSERT_PAYOUT), {"id": payout_id, "created": at})
    newest_first = sorted(created, key=lambda payout_id: (created[payout_id], payout_id))[::-1]
    first = await service.owner_summary(user_id="owner")
    second = await service.owner_summary(user_id="owner", cursor=first["nextCursor"])
    assert second["nextCursor"] is None
    ids = [payout["id"] for payout in first["payouts"] + second["payouts"]]
    assert (len(first["payouts"]), ids) == (20, [*newest_first, "po_one"])


def _event_check(engine):
    with engine.connect() as connection:
        return tuple(
            connection.execute(
                text("""SELECT oid::bigint,pg_get_constraintdef(oid) FROM pg_constraint
                  WHERE conname='stripe_connect_bank_payout_events_event_type_check'""")
            ).one()
        )


def _recorded_events(engine):
    with engine.connect() as connection:
        rows = connection.execute(
            text("""SELECT stripe_event_id,event_type FROM stripe_connect_bank_payout_events
              ORDER BY stripe_event_id""")
        ).all()
    return [tuple(row) for row in rows]


@pytest.mark.asyncio
async def test_new_connect_events_are_recorded_once_and_keep_the_release_replay_green(
    bank_db, monkeypatch
):
    engine = bank_db
    await asyncio.to_thread(_replay, engine, SNAPSHOT)
    service, fake, ledger_calls = _service(engine, monkeypatch)
    balance = signed_event(event_id="evt_balance", kind="balance.available")
    assert await service.process_webhook(**balance) == "updated"
    fake.payout_status = "paid"
    fake.payout_details = {"reconciliation_status": "completed"}
    reconciled = signed_event(event_id="evt_reconciled", kind="payout.reconciliation_completed")
    assert await service.process_webhook(**reconciled) == "updated"
    # Stripe redelivers: each event is recorded once and its effects run once.
    assert await service.process_webhook(**balance) == "duplicate"
    assert await service.process_webhook(**reconciled) == "duplicate"
    assert [call for call, _ in ledger_calls] == ["refresh_due", "reconcile"]
    recorded = [
        ("evt_balance", "balance.available"),
        ("evt_reconciled", "payout.reconciliation_completed"),
    ]
    assert _recorded_events(engine) == recorded

    # Negative control: migration 304 run as published re-adds its narrower
    # event CHECK, so the recorded rows would fail that deploy.
    published_304 = (MIGRATIONS / EARLIER[1]).read_text(encoding="utf-8")
    with pytest.raises(pg_errors.CheckViolation):
        _script(engine, published_304, lock_timeout_ms=5_000)

    # Every deploy replays 294 and 304 before 316. Release replay only widens the
    # event CHECK: it passes, leaves the installed CHECK alone and keeps the rows.
    installed = _event_check(engine)
    assert "'balance.available'" in installed[1]
    assert "'payout.reconciliation_completed'" in installed[1]
    await asyncio.to_thread(_replay, engine, *EARLIER, SNAPSHOT)
    await asyncio.to_thread(_replay, engine, *EARLIER)
    assert _event_check(engine) == installed
    assert _recorded_events(engine) == recorded
