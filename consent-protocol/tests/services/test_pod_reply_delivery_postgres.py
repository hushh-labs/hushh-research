"""Reply leases, device transfer, cascade erasure and rollback on isolated Postgres."""

from __future__ import annotations

import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL

from db.db_client import DatabaseClient
from hushh_mcp.services.one_reply_delivery import OneReplyDelivery
from hushh_mcp.services.push_notifications import PushDeliveryReport
from hushh_mcp.services.push_tokens_service import PushTokensService

MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"


@pytest.fixture
def database(monkeypatch):
    import psycopg2
    from psycopg2 import sql

    url = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not url:
        pytest.skip("An isolated PostgreSQL database is required.")
    url = url.replace("postgresql+psycopg2://", "postgresql://", 1)
    admin = psycopg2.connect(url)
    admin.autocommit = True
    name = "reply_test_" + uuid4().hex
    with admin.cursor() as cursor:
        cursor.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    parts = urlsplit(url)
    engine = create_engine(
        URL.create(
            "postgresql+psycopg2",
            username=parts.username,
            password=parts.password,
            host=parts.hostname,
            port=parts.port,
            database=name,
        )
    )
    db = DatabaseClient(engine)
    try:
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE actor_profiles (user_id TEXT PRIMARY KEY)"))
            connection.execute(text("CREATE TABLE vault_keys (user_id TEXT PRIMARY KEY)"))
            connection.execute(text("INSERT INTO actor_profiles VALUES ('owner'), ('other')"))
            connection.execute(
                text("""CREATE TABLE user_push_tokens (
                id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL,
                token TEXT NOT NULL, platform TEXT NOT NULL,
                created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, UNIQUE(user_id, platform))""")
            )
        with engine.connect() as connection:
            connection.connection.cursor().execute(
                (MIGRATIONS / "201_account_deletion_tombstones.sql").read_text()
            )
            connection.commit()
        for migration in ("959_pod_reply_deliveries.sql", "960_user_push_devices.sql"):
            with engine.connect() as connection:
                connection.connection.cursor().execute(
                    (MIGRATIONS / "parked" / migration).read_text()
                )
                connection.commit()
        from hushh_mcp.services import push_tokens_service

        monkeypatch.setattr(push_tokens_service, "get_db", lambda: db)
        yield db
    finally:
        engine.dispose()
        with admin.cursor() as cursor:
            cursor.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
        admin.close()


def _signal(run="run"):
    now = int(time.time())
    return SimpleNamespace(
        eventId=("a" if run == "run" else "b") * 64,
        conversationId="conversation_1",
        runId=run,
        createdAt=now,
        expiresAt=now + 21600,
        read=False,
    )


def test_concurrent_claim_partial_device_receipt_and_stale_finish(database):
    delivery = OneReplyDelivery(database)
    signal = _signal()

    def claim():
        return delivery.accept(owner_id="owner", hushh_id="ha1_owner", signal=signal)

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: claim(), range(2)))
    claimed = [row for row, _ in results if row]
    assert len(claimed) == 1 and claimed[0]["attempts"] == 1
    delivery.record_accepted(
        owner_id="owner", event_id=signal.eventId, attempt=1, token_hash="c" * 64
    )
    assert (
        delivery.finish(
            owner_id="owner",
            event_id=signal.eventId,
            attempt=1,
            report=PushDeliveryReport(configured=True, retryable=True, accepted={"c" * 64}),
        )
        == "pending"
    )
    database.execute_raw(
        "UPDATE one_reply_deliveries SET next_attempt_at=NOW(), leased_until=NOW()-INTERVAL '1 second'",
        {},
    )
    row, _ = claim()
    assert row["attempts"] == 2 and row["accepted_devices"] == ["c" * 64]
    # A late attempt must not falsely acknowledge the winning pending lease.
    assert (
        delivery.finish(
            owner_id="owner",
            event_id=signal.eventId,
            attempt=1,
            report=PushDeliveryReport(configured=True, accepted={"c" * 64}),
        )
        == "pending"
    )
    assert delivery.is_sendable(owner_id="owner", event_id=signal.eventId, attempt=2)
    assert (
        delivery.finish(
            owner_id="owner",
            event_id=signal.eventId,
            attempt=2,
            report=PushDeliveryReport(configured=True, accepted={"c" * 64, "d" * 64}),
        )
        == "sent"
    )
    assert claim() == (None, "sent")


def test_read_blocks_send_and_never_acknowledges_a_future_turn(database):
    delivery = OneReplyDelivery(database)
    signal = _signal()
    delivery.accept(owner_id="owner", hushh_id="ha1_owner", signal=signal)
    signal.read = True
    assert delivery.accept(owner_id="owner", hushh_id="ha1_owner", signal=signal) == (None, "read")
    assert not delivery.is_sendable(owner_id="owner", event_id=signal.eventId, attempt=1)
    assert (
        delivery.finish(
            owner_id="owner",
            event_id=signal.eventId,
            attempt=1,
            report=PushDeliveryReport(configured=True),
        )
        == "read"
    )
    future, _ = delivery.accept(owner_id="owner", hushh_id="ha1_owner", signal=_signal("future"))
    assert future["state"] == "pending"


def test_multidevice_transfer_and_exact_logout_preserve_other_devices(database):
    tokens = PushTokensService()
    tokens.upsert_user_push_token("owner", "phone-a", "ios")
    tokens.upsert_user_push_token("owner", "phone-b", "ios")
    rows = database.execute_raw(
        "SELECT token FROM user_push_devices WHERE user_id='owner'", {}
    ).data
    assert {row["token"] for row in rows} == {"phone-a", "phone-b"}
    tokens.upsert_user_push_token("other", "phone-a", "android")
    tokens.delete_user_push_tokens("owner", "ios", "phone-a")
    rows = database.execute_raw("SELECT user_id, token FROM user_push_devices", {}).data
    assert {(row["user_id"], row["token"]) for row in rows} == {
        ("owner", "phone-b"),
        ("other", "phone-a"),
    }
    tokens.delete_user_push_tokens("owner", "ios", "phone-b")
    assert database.execute_raw("SELECT token FROM user_push_devices", {}).data == [
        {"token": "phone-a"}
    ]


def test_migration_cascade_and_down_paths_preserve_legacy_registry(database):
    PushTokensService().upsert_user_push_token("owner", "owner-device", "ios")
    OneReplyDelivery(database).accept(owner_id="owner", hushh_id="ha1_owner", signal=_signal())
    database.execute_raw("DELETE FROM actor_profiles WHERE user_id='owner'", {})
    assert database.execute_raw("SELECT * FROM one_reply_deliveries", {}).data == []
    assert database.execute_raw("SELECT * FROM user_push_devices", {}).data == []
    for migration in (
        "959_pod_reply_deliveries.rollback.sql",
        "960_user_push_devices.rollback.sql",
    ):
        with database.engine.connect() as connection:
            connection.exec_driver_sql((MIGRATIONS / "rollback" / migration).read_text())
            connection.commit()
    assert database.execute_raw("SELECT token FROM user_push_tokens", {}).data == [
        {"token": "owner-device"}
    ]
