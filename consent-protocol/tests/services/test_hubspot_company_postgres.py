"""Real delivery SQL, erasure fences and migration rollback on a disposable DB."""

import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from threading import Event
from unittest.mock import Mock
from uuid import uuid4

import psycopg2
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError

from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_user_hash
from hushh_mcp.services.hubspot_company_contract import receipt_key
from hushh_mcp.services.hubspot_company_store import erase_in_transaction
from hushh_mcp.services.hubspot_company_sync import HubSpotCompanySync

pytestmark = pytest.mark.db
ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def company_db():
    configured = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not configured:
        pytest.skip("Canonical disposable PostgreSQL administrator URL is required")
    url = make_url(configured).set(drivername="postgresql+psycopg2")
    name = "company_crm_test_" + uuid4().hex
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql(f'CREATE DATABASE "{name}"')
    engine = create_engine(url.set(database=name), pool_size=4)
    migration = (ROOT / "db/migrations/433_one_company_crm_delivery.sql").read_text()
    rollback = (
        ROOT / "db/migrations/rollback/433_one_company_crm_delivery.rollback.sql"
    ).read_text()

    @contextmanager
    def connect():
        with engine.connect() as conn:
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise

    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.exec_driver_sql(
                "CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY); CREATE TABLE vault_keys(user_id TEXT PRIMARY KEY, setup_completed BOOLEAN)"
            )
            for filename in (
                "201_account_deletion_tombstones.sql",
                "365_one_product_activity_observations.sql",
            ):
                conn.connection.cursor().execute((ROOT / "db/migrations" / filename).read_text())
            conn.connection.cursor().execute(migration)
            conn.connection.cursor().execute(migration)
            conn.connection.cursor().execute(rollback)
            conn.connection.cursor().execute(migration)
            conn.exec_driver_sql(
                "INSERT INTO actor_profiles VALUES('owner'); INSERT INTO vault_keys VALUES('owner',TRUE)"
            )
            conn.exec_driver_sql("INSERT INTO one_product_activity_epochs(user_id) VALUES('owner')")
            conn.exec_driver_sql("""INSERT INTO one_product_activity_observations
              SELECT repeat('a',64),'owner',generation,'agent_one','agent:agent_one',repeat('b',64),
              'execution_observed','returned',NOW(),NOW()+INTERVAL '7 days'
              FROM one_product_activity_epochs WHERE user_id='owner'""")
        yield engine, connect, migration, rollback
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.exec_driver_sql(f'DROP DATABASE "{name}" WITH (FORCE)')
        admin.dispose()


def test_company_delivery_and_erasure_on_disposable_postgres(monkeypatch, company_db):
    engine, connect, migration, rollback = company_db
    monkeypatch.setenv("ONE_HUBSPOT_SYNC_ENABLED", "true")
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    client = Mock(portal_id="1234")
    worker = HubSpotCompanySync(client, connect=connect)
    worker._scan_accounts()
    worker._scan_activity()
    worker._scan_activity()
    worker._maintenance()
    rows = worker._rows(cleanup=False, limit=50)
    assert len(rows) == 2 and {r["kind"] for r in rows} == {"contact", "activity"}
    activity = next(r for r in rows if r["kind"] == "activity")
    assert activity["item_id"] == receipt_key("activity", "a" * 64)
    assert (activity["expires_at"] - activity["observed_at"]).days == 90
    with connect() as conn:
        conn.execute(
            text(
                "UPDATE one_company_crm_deliveries SET state='sent',remote_contact_id='10' WHERE kind='contact'"
            )
        )
    _assert_dispatch_barrier(connect, worker, client, activity)
    _assert_unknown_reconciliation(connect, worker, client)
    _assert_erasure(engine, connect, worker, client, migration, rollback)


def _assert_dispatch_barrier(connect, worker, client, activity):
    entered, release = Event(), Event()
    client.find_note.return_value = None

    def create(*_):
        entered.set()
        assert release.wait(5)
        return "11"

    client.create_note.side_effect = create
    with ThreadPoolExecutor(max_workers=1) as executor:
        running = executor.submit(worker._dispatch, activity)
        assert entered.wait(5)
        try:
            # Erasure cannot cross a currently dispatched owner's barrier.
            with pytest.raises(DBAPIError):
                with connect() as conn:
                    conn.execute(text("SET LOCAL lock_timeout='200ms'"))
                    conn.execute(
                        text("SELECT pg_advisory_xact_lock(hashtextextended('owner',171))")
                    )
        finally:
            release.set()
        running.result(timeout=5)


def _assert_unknown_reconciliation(connect, worker, client):
    with connect() as conn:
        conn.execute(
            text(
                "UPDATE one_company_crm_deliveries SET state='sending',remote_note_id=NULL,remote_outcome_unknown=TRUE WHERE kind='activity'"
            )
        )
    worker._maintenance()
    unknown = next(r for r in worker._rows(cleanup=False, limit=50) if r["kind"] == "activity")
    from hushh_mcp.services.hubspot_company_client import CompanyCrmError

    with pytest.raises(CompanyCrmError, match="company_note_outcome_unknown"):
        worker._dispatch(unknown)
    assert client.create_note.call_count == 1
    client.find_note.return_value = "11"
    worker._dispatch(unknown)
    assert client.create_note.call_count == 1


def _assert_erasure(engine, connect, worker, client, migration, rollback):
    with pytest.raises(DBAPIError):
        with connect() as conn:
            conn.execute(
                text(
                    "UPDATE one_company_crm_deliveries SET owner_user_id=NULL,cleanup_requested=TRUE,payload='{}',generation=NULL"
                )
            )
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        try:
            with pytest.raises(psycopg2.Error):
                conn.connection.cursor().execute(rollback)
        finally:
            conn.connection.cursor().execute("ROLLBACK")
    with connect() as conn:
        conn.execute(
            text(
                "SELECT pg_advisory_xact_lock(hashtextextended('owner',171)); SELECT pg_advisory_xact_lock(hashtextextended('owner',198))"
            )
        )
        conn.execute(
            text(
                "INSERT INTO account_deletion_tombstones(user_id_hash,firebase_uid) VALUES(:hash,'owner')"
            ),
            {"hash": account_deletion_user_hash("owner")},
        )
        erase_in_transaction(conn, "owner", permanent=True)
        conn.execute(text("DELETE FROM actor_profiles WHERE user_id='owner'"))
    cleanup = worker._rows(cleanup=True, limit=50)
    assert len(cleanup) == 2
    assert all(
        r["owner_user_id"] is None and r["payload"] == {} and r["generation"] is None
        for r in cleanup
    )
    client.clear_owned_contact.return_value = True
    for row in cleanup:
        worker._dispatch(row)
    client.delete_note.assert_called_once_with("11")
    assert worker._rows(cleanup=True, limit=50) == []
    assert worker._rows(cleanup=False, limit=50) == []
    with pytest.raises(DBAPIError):
        with connect() as conn:
            conn.execute(text("INSERT INTO actor_profiles VALUES('owner')"))
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        conn.connection.cursor().execute(rollback)
        conn.connection.cursor().execute(migration)
