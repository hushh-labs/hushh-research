"""Location Feed receipts and authorization against disposable PostgreSQL."""

from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

import pytest

from hushh_mcp.services import location_check_in_operations as operations
from hushh_mcp.services.one_location_agent_service import OneLocationAgentError
from tests.services import test_location_command_postgres as command_support

db = command_support.db
audience_writer_schema = command_support.audience_writer_schema

REVIEWED_AT = datetime.now(UTC)
MIGRATIONS = Path(__file__).resolve().parents[2] / "db/migrations"


@pytest.fixture
def check_in(db, monkeypatch):
    service = audience_writer_schema(db, monkeypatch)
    db.execute_raw("INSERT INTO actor_profiles VALUES('third') ON CONFLICT DO NOTHING")
    db.execute_raw(
        "ALTER TABLE feed_events ADD COLUMN id BIGSERIAL, ADD COLUMN created_at TIMESTAMPTZ DEFAULT now(), ADD COLUMN read_at TIMESTAMPTZ"
    )
    with db.engine.begin() as conn:
        conn.exec_driver_sql(
            (MIGRATIONS / "462_location_check_in_operations.sql").read_text(),
            execution_options={"no_parameters": True},
        )

    @contextmanager
    def connection():
        with db.engine.begin() as conn:
            yield conn

    monkeypatch.setattr(operations, "get_db_connection", connection)
    plan = operations.begin_check_in(
        owner="owner",
        client_operation_id="explicit-qa",
        recipient_ids=["other", "third"],
        duration_hours=2,
        confirmed_at=datetime.now(UTC),
    )
    return service, plan


def send(service, *, recipient="other", key="key", client="explicit-qa"):
    return service().create_grant_with_initial_envelope(
        owner_user_id="owner",
        recipient_user_id=recipient,
        recipient_key_id=key,
        duration_hours=2,
        duration_mode="timed",
        reason="check_in",
        share_kind="check_in",
        enforce_connection=True,
        client_operation_id=client,
        confirmed_at=REVIEWED_AT,
        envelope={
            "recipientKeyId": key,
            "algorithm": "ECDH-P256-AES256-GCM",
            "ciphertext": "synthetic-ciphertext",
            "iv": "iv",
            "senderEphemeralPublicKeyJwk": {"kty": "EC"},
            "capturedAt": REVIEWED_AT.isoformat(),
            "sourcePlatform": "web",
        },
    )


def test_check_in_counts_saved_receipts_and_retries_only_intended_people(db, check_in):
    service, plan = check_in
    empty = operations.settle_check_in(owner="owner", operation=plan["id"])
    assert empty["confirmedCount"] == 0 and empty["state"] == "failed"
    with pytest.raises(operations.CheckInOperationError):
        operations.get_check_in(owner="other", operation=plan["id"])
    first = send(service)
    # The receipt is committed without depending on the client's settle call.
    current = operations.get_check_in(owner="owner", operation=plan["id"])
    assert current["confirmedCount"] == 1 and current["state"] == "pending"
    assert (
        db.execute_raw(
            "SELECT count(*) AS n FROM feed_events WHERE event_type='location_check_in_attention'"
        ).data[0]["n"]
        == 1
    )  # only the stopped empty attempt
    partial = operations.settle_check_in(owner="owner", operation=plan["id"])
    assert partial["state"] == "partial" and partial["pendingCount"] == 1
    assert send(service)["idempotentReplay"] is True
    assert db.execute_raw("SELECT count(*) AS n FROM one_location_share_grants").data[0]["n"] == 1
    assert (
        operations.begin_check_in(
            owner="owner",
            client_operation_id="explicit-qa",
            recipient_ids=["third"],
            duration_hours=2,
            confirmed_at=datetime.now(UTC),
        )["intendedCount"]
        == 2
    )
    with pytest.raises(operations.CheckInOperationError):
        operations.begin_check_in(
            owner="owner",
            client_operation_id="explicit-qa",
            recipient_ids=["other", "outsider"],
            duration_hours=2,
            confirmed_at=datetime.now(UTC),
        )
    db.execute_raw(
        "UPDATE one_location_share_grants SET status='revoked' WHERE id=:id",
        {"id": first["grant"]["id"]},
    )
    assert operations.get_check_in(owner="owner", operation=plan["id"])["state"] == "partial"
    second = send(service, recipient="third", key="key-3")
    complete = operations.get_check_in(owner="owner", operation=plan["id"])
    assert complete["confirmedCount"] == 2 and complete["state"] == "completed"
    db.execute_raw(
        "UPDATE one_location_share_grants SET status='expired' WHERE id=:id",
        {"id": second["grant"]["id"]},
    )
    assert operations.get_check_in(owner="owner", operation=plan["id"])["state"] == "ended"


def test_unknown_audience_cannot_resolve_private_identity(db, check_in):
    with pytest.raises(operations.CheckInOperationError) as exc:
        operations.begin_check_in(
            owner="owner",
            client_operation_id="foreign-audience",
            recipient_ids=["outsider"],
            duration_hours=2,
            confirmed_at=datetime.now(UTC),
        )
    assert exc.value.status_code == 403
    assert (
        db.execute_raw("SELECT count(*) AS n FROM one_location_check_in_operations").data[0]["n"]
        == 1
    )


def test_envelope_read_rechecks_revocation_at_ciphertext_selection(db, check_in, monkeypatch):
    service, _ = check_in
    grant = send(service)["grant"]["id"]
    reader = service()
    original = reader._execute_one

    def revoke_after_review(sql, params=None):
        result = original(sql, params)
        if "FROM one_location_share_grants g" in sql:
            db.execute_raw(
                "UPDATE one_location_share_grants SET status='revoked' WHERE id=:id", {"id": grant}
            )
        return result

    monkeypatch.setattr(reader, "_execute_one", revoke_after_review)
    with pytest.raises(OneLocationAgentError) as exc:
        reader.view_latest_envelope(recipient_user_id="other", grant_id=grant, allow_empty=True)
    assert exc.value.status_code == 410
    # Negative control: a grant-unchecked envelope query still returns ciphertext.
    assert db.execute_raw(
        "SELECT id FROM one_location_envelopes WHERE grant_id=:id", {"id": grant}
    ).data
    assert (
        db.execute_raw(
            "SELECT id FROM one_location_events WHERE event_type='location_share_viewed'"
        ).data
        == []
    )


def test_check_in_migration_rollback_refuses_live_receipts(db, check_in):
    rollback = (MIGRATIONS / "rollback/462_location_check_in_operations.rollback.sql").read_text()
    with pytest.raises(Exception, match="location_check_in_rollback_requires_empty_operations"):
        with db.engine.begin() as conn:
            conn.exec_driver_sql(rollback, execution_options={"no_parameters": True})
    db.execute_raw("DELETE FROM one_location_check_in_operations")
    with db.engine.begin() as conn:
        conn.exec_driver_sql(rollback, execution_options={"no_parameters": True})
    assert (
        db.execute_raw("SELECT to_regclass('one_location_check_in_operations') AS table_name").data[
            0
        ]["table_name"]
        is None
    )


def test_two_partial_check_ins_resume_without_locking_each_others_old_operation(
    db, check_in, monkeypatch
):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from hushh_mcp.services import location_check_in_receipts as receipts

    service, _ = check_in
    operations.begin_check_in(
        owner="owner",
        client_operation_id="second-qa",
        recipient_ids=["other", "third"],
        duration_hours=2,
        confirmed_at=REVIEWED_AT,
    )
    send(service)
    send(service, recipient="third", key="key-3", client="second-qa")
    barrier = Barrier(2)
    record = receipts.record_check_in_receipt

    def wait_after_replacement(conn, params, row):
        barrier.wait(timeout=10)
        return record(conn, params, row)

    monkeypatch.setattr(receipts, "record_check_in_receipt", wait_after_replacement)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(send, service, recipient="third", key="key-3")
        second = pool.submit(send, service, recipient="other", client="second-qa")
        assert first.result(timeout=15)["grant"]["recipientUserId"] == "third"
        assert second.result(timeout=15)["grant"]["recipientUserId"] == "other"
    assert (
        db.execute_raw(
            "SELECT count(*) AS n FROM one_location_check_in_operations WHERE confirmed_count=2"
        ).data[0]["n"]
        == 2
    )
