"""Release replay keeps every recorded Connect event type on real PostgreSQL.

Migrations 298 and 304 re-add an exact Connect event CHECK. Replayed as
published, one stored row of a later type (payout.canceled after 298,
balance.available after 316) fails every following deploy. The runner adapts
their published bodies to widen only, and must leave an installed superset and
its rows untouched. Skips without ONE_COMMAND_TEST_DATABASE_URL.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import asyncpg
import pytest
from sqlalchemy.engine import make_url

from db.migration_authority import (
    MigrationMode,
    _replay_sql,
    apply_manifest_entries,
    build_manifest_entries,
)

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "db" / "migrations"
BANK_EVENTS = "294_drive_request_bank_payout_events.sql"
STRIPE_MODES = "298_stripe_mode_isolation.sql"
RECONCILIATION = "304_connect_bank_payout_reconciliation.sql"
SNAPSHOT = "316_connect_bank_payout_snapshot.sql"
CHECK = "stripe_connect_bank_payout_events_event_type_check"
INSERT_EVENT = """INSERT INTO stripe_connect_bank_payout_events
  (stripe_event_id,stripe_account_id,event_type,stripe_object_id,livemode)
  VALUES ($1,'acct_owner',$2,'acct_owner',FALSE)"""
LATER_TYPES = ("payout.canceled", "balance.available", "payout.reconciliation_completed")


@pytest.fixture
async def bank_db():
    source = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not source:
        pytest.skip("An isolated PostgreSQL server is required.")
    url = make_url(source).set(drivername="postgresql")
    name = "bank_event_replay_" + uuid.uuid4().hex
    admin = await asyncpg.connect(url.render_as_string(hide_password=False))
    await admin.execute(f'CREATE DATABASE "{name}"')
    writer = await asyncpg.connect(url.set(database=name).render_as_string(hide_password=False))
    try:
        # Migration 298's owner mapping, without the checkout tables 298 also alters.
        await writer.execute("""CREATE TABLE stripe_owner_payout_accounts (
          user_id TEXT NOT NULL,
          stripe_mode TEXT NOT NULL CHECK (stripe_mode IN ('test','live')),
          stripe_account_id TEXT NOT NULL UNIQUE,
          details_submitted BOOLEAN NOT NULL DEFAULT FALSE,
          payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
          account_ready BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
          PRIMARY KEY (user_id,stripe_mode))""")
        await _replay(writer, BANK_EVENTS, RECONCILIATION, SNAPSHOT)
        yield writer
    finally:
        await writer.close()
        await admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
        await admin.close()


async def _replay(writer, *filenames):
    await apply_manifest_entries(
        writer, build_manifest_entries(MIGRATIONS, filenames), mode=MigrationMode.REPLAY
    )


async def _check(writer):
    return await writer.fetchrow(
        "SELECT oid, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname=$1",
        CHECK,
    )


def _repair_block(sql: str) -> str:
    start = sql.index("DO $$\nDECLARE\n  installed TEXT[];")
    return sql[start : sql.index("END $$;", start) + len("END $$;")]


@pytest.mark.asyncio
async def test_replay_keeps_recorded_later_event_types_without_relocking(bank_db):
    writer = bank_db
    for index, event_type in enumerate(LATER_TYPES):
        await writer.execute(INSERT_EVENT, f"evt_later_{index}", event_type)
    installed = await _check(writer)

    # Negative control: 304 replayed as published rejects the stored rows.
    entry = build_manifest_entries(MIGRATIONS, (RECONCILIATION,))[0]
    with pytest.raises(asyncpg.CheckViolationError):
        await writer.execute(entry.sql)
    await writer.execute("ROLLBACK")

    await _replay(writer, BANK_EVENTS, RECONCILIATION, SNAPSHOT)
    await _replay(writer, BANK_EVENTS, RECONCILIATION, SNAPSHOT)
    # An installed superset is inspected only: same constraint, no re-validation.
    assert await _check(writer) == installed
    assert await writer.fetchval("SELECT count(*) FROM stripe_connect_bank_payout_events") == 3

    # 298's adapted body widens the same way; its narrow CHECK is gone.
    adapted = _replay_sql(build_manifest_entries(MIGRATIONS, (STRIPE_MODES,))[0])
    assert "'payout.paid','payout.failed'));" not in adapted
    await writer.execute(_repair_block(adapted))
    assert await _check(writer) == installed


@pytest.mark.asyncio
async def test_replay_widens_a_narrow_installed_check_and_keeps_its_rows(bank_db):
    writer = bank_db
    await writer.execute(f"ALTER TABLE stripe_connect_bank_payout_events DROP CONSTRAINT {CHECK}")
    await writer.execute(
        f"ALTER TABLE stripe_connect_bank_payout_events ADD CONSTRAINT {CHECK} "
        "CHECK (event_type IN ('payout.paid','account.future_event'))"
    )
    await writer.execute(INSERT_EVENT, "evt_future", "account.future_event")

    await _replay(writer, BANK_EVENTS, RECONCILIATION)

    definition = (await _check(writer))["definition"]
    assert "account.future_event" in definition and "payout.canceled" in definition
    await writer.execute(INSERT_EVENT, "evt_canceled", "payout.canceled")
    with pytest.raises(asyncpg.CheckViolationError):
        await writer.execute(INSERT_EVENT, "evt_unknown", "payout.unknown")
