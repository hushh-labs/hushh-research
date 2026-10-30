"""Disposable Postgres proof of transactional source hints and owner erasure."""

# ruff: noqa: F811 -- shared disposable Postgres fixture is imported by name

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import create_engine, text

from hushh_mcp.services.account_service import AccountService
from hushh_mcp.services.source_journal_service import SourceJournalService
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url,  # noqa: F401
)

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db/migrations/345_live_memory_source_journal.sql"


def _read(engine, owner: str, after: int = 0, limit: int = 100) -> dict:
    return asyncio.run(
        SourceJournalService(SimpleNamespace(engine=engine)).events(
            user_id=owner, after=after, limit=limit
        )
    )


def _owner_hash(owner: str) -> str:
    return "sha256:" + hashlib.sha256(owner.encode()).hexdigest()


def test_source_journal_committed_owner_hints_gap_and_erasure(connector_postgres_url):
    engine = create_engine(connector_postgres_url)
    with engine.begin() as connection:
        # The journal migration is intentionally independently replayable. Only
        # columns it reads are needed to model the existing source authorities.
        for ddl in (
            "CREATE TABLE account_deletion_tombstones (user_id_hash TEXT PRIMARY KEY)",
            "CREATE TABLE actor_profiles (user_id TEXT PRIMARY KEY)",
            "CREATE TABLE vault_keys (user_id TEXT PRIMARY KEY)",
            "CREATE TABLE actor_identity_cache (user_id TEXT, display_name TEXT, email TEXT, photo_url TEXT, custom_photo_url TEXT, last_synced_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)",
            "CREATE TABLE consent_audit (user_id TEXT, action TEXT)",
            "CREATE TABLE one_information_request_bundles (requester_user_id TEXT, subject_user_id TEXT)",
            "CREATE TABLE drive_share_requests (user_id TEXT, recipient_user_id TEXT)",
            "CREATE TABLE one_location_share_grants (owner_user_id TEXT, recipient_user_id TEXT)",
            "CREATE TABLE marketplace_access_requests (owner_user_id TEXT, buyer_user_id TEXT)",
            "CREATE TABLE pkm_answer_requests (owner_user_id TEXT, requester_user_id TEXT)",
            "CREATE TABLE connections (user_a_id TEXT, user_b_id TEXT, status TEXT)",
            "CREATE TABLE connection_requests (requester_user_id TEXT, addressee_user_id TEXT)",
            "CREATE TABLE trusted_connections (owner_user_id TEXT, trusted_user_id TEXT)",
            "CREATE TABLE drive_request_payment_orders (request_id UUID, user_id TEXT, requester_user_id TEXT)",
            "CREATE TABLE drive_request_payment_refunds (request_id UUID, status TEXT)",
            "CREATE TABLE drive_request_owner_payouts (request_id UUID, status TEXT)",
            "CREATE TABLE hashcoin_wallets (wallet_id UUID, user_id TEXT)",
            "CREATE TABLE hashcoin_ledger_entries (wallet_id UUID)",
            "CREATE TABLE hashcoin_redemptions (wallet_id UUID)",
            "CREATE TABLE stripe_connect_bank_payouts (stripe_account_id TEXT, livemode BOOLEAN)",
            "CREATE TABLE stripe_connect_balance_transactions (stripe_account_id TEXT, livemode BOOLEAN)",
            "CREATE TABLE stripe_owner_payout_accounts (stripe_account_id TEXT, stripe_mode TEXT, user_id TEXT)",
        ):
            connection.exec_driver_sql(ddl)
    for _ in range(2):
        with engine.begin() as connection:
            connection.exec_driver_sql(
                MIGRATION.read_text(), execution_options={"no_parameters": True}
            )

    with engine.begin() as connection:
        connection.execute(text("INSERT INTO actor_profiles VALUES ('owner-a'),('owner-b')"))
        connection.execute(text("INSERT INTO vault_keys VALUES ('owner-a'),('owner-b')"))
        connection.execute(
            text("""INSERT INTO actor_identity_cache
            (user_id,display_name,email) VALUES
            ('owner-a','Ankit Kumar Singh','private@example.com')""")
        )
        connection.execute(text("INSERT INTO consent_audit VALUES ('owner-a','GRANT')"))
        connection.execute(text("INSERT INTO connections VALUES ('owner-a','owner-b','active')"))
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders VALUES
            ('00000000-0000-0000-0000-000000000001','owner-b','owner-a')""")
        )
    page = _read(engine, "owner-a")
    assert [event["sourceKind"] for event in page["events"]] == [
        "profile",
        "consent",
        "connection",
        "document_request_payment",
    ]
    assert [event["sourceKind"] for event in _read(engine, "owner-b")["events"]] == [
        "connection",
        "document_earning",
    ]
    serialized = json.dumps(page)
    assert "Ankit Kumar Singh" not in serialized
    assert "private@example.com" not in serialized
    assert "owner-b" not in serialized
    assert "00000000-0000-0000-0000-000000000001" not in serialized

    with engine.begin() as connection:
        connection.execute(
            text("""UPDATE actor_identity_cache
            SET last_synced_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE user_id='owner-a'""")
        )
    assert _read(engine, "owner-a")["headCursor"] == "4"

    try:
        with engine.begin() as connection:
            connection.execute(
                text("""UPDATE actor_identity_cache
                SET display_name='Rolled back' WHERE user_id='owner-a'""")
            )
            raise RuntimeError("abort source write")
    except RuntimeError:
        pass
    assert _read(engine, "owner-a")["headCursor"] == "4"

    with engine.begin() as connection:
        connection.execute(
            text("""UPDATE actor_identity_cache
            SET display_name='Ankit' WHERE user_id='owner-a'""")
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_refunds
            VALUES ('00000000-0000-0000-0000-000000000001','succeeded')""")
        )
    tail = _read(engine, "owner-a", after=4)
    assert [event["sourceKind"] for event in tail["events"]] == [
        "profile",
        "document_request_payment",
    ]
    assert [event["sequence"] for event in tail["events"]] == ["5", "6"]

    with engine.begin() as connection:
        connection.execute(
            text("""DELETE FROM live_memory_source_events
            WHERE owner_hash=:owner_hash AND sequence=5"""),
            {"owner_hash": _owner_hash("owner-a")},
        )
    assert _read(engine, "owner-a", after=4)["resetRequired"] is True
    assert _read(engine, "owner-a", after=999)["resetRequired"] is True

    with engine.begin() as connection:
        results = {}
        AccountService._clear_live_memory_source_journal(
            connection, "owner-a", results, permanent=False
        )
    assert results["live_memory_source_journal"] is True
    assert _read(engine, "owner-a", after=6)["resetRequired"] is True
    assert _read(engine, "owner-a", after=0)["events"] == []

    with engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO account_deletion_tombstones VALUES
            (:owner_hash)"""),
            {"owner_hash": _owner_hash("owner-a")},
        )
        connection.execute(text("DELETE FROM actor_identity_cache WHERE user_id='owner-a'"))
        connection.execute(text("DELETE FROM actor_profiles WHERE user_id='owner-a'"))
    assert _read(engine, "owner-a")["events"] == []
    with engine.begin() as connection:
        count = connection.execute(
            text("""SELECT count(*) FROM live_memory_source_streams
            WHERE owner_hash=:owner_hash"""),
            {"owner_hash": _owner_hash("owner-a")},
        ).scalar_one()
    assert count == 0
