"""The asker withdraws a Drive question; a revoked grant asks the owner to reconnect.

Real isolated PostgreSQL with migration 243 applied twice (replay mode). The
guarantees under test: only the asker can cancel, a cancel never reads Drive,
a cancel during a running Allow stores no answer, every Allow is per question,
and allowing a question never touches the file-sharing permission executor.
"""

# ruff: noqa: F811 -- shared pytest fixture imports

import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from hushh_mcp.services.drive_chat_service import DriveChatService
from hushh_mcp.services.drive_permission_executor import DrivePermissionExecutor
from hushh_mcp.services.drive_sharing_center_contributor import DriveSharingCenterContributor
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from tests.services.test_drive_document_selection import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
)
from tests.services.test_drive_live_query import (  # noqa: F401
    OWNER_PROOF,
    abandon,
    ask,
    disconnect,
    fake_reader,
    live_chat,
    match,
    no_drive,
    row,
    service,
    store,
)
from tests.services.test_drive_sharing_store import MIGRATIONS, sharing  # noqa: F401

CANCEL_MIGRATION = MIGRATIONS / "243_drive_live_query_cancel.sql"
CANCEL_ROLLBACK = MIGRATIONS / "rollback" / "243_drive_live_query_cancel.rollback.sql"


def run_sql(store, path):
    with store.db.engine.connect() as connection:
        with connection.connection.driver_connection.cursor() as cursor:
            cursor.execute(path.read_text())
        connection.commit()


@pytest.fixture
async def cancellable(store):
    # Replay mode executes every manifest file on every deploy.
    run_sql(store, CANCEL_MIGRATION)
    run_sql(store, CANCEL_MIGRATION)
    return store


def status_checks(store):
    with store.db.engine.connect() as connection:
        return list(
            connection.execute(
                text("""
                SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
                WHERE conrelid='drive_live_query_requests'::regclass AND contype='c'
                  AND pg_get_constraintdef(oid) LIKE '%denied%'
            """)
            ).mappings()
        )


def set_status(store, request_id, status):
    with store.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_live_query_requests SET status=:status, decided_at=now() "
                "WHERE request_id=:id"
            ),
            {"status": status, "id": request_id},
        )


async def test_migration_243_admits_cancelled_and_replays(cancellable):
    [check] = status_checks(cancellable)
    assert check["conname"] == "drive_live_query_requests_status_check"
    assert "'cancelled'" in check["definition"]
    created = await ask(cancellable)
    set_status(cancellable, created["requestId"], "cancelled")
    with pytest.raises(IntegrityError, match="drive_live_query_requests_status_check"):
        set_status(cancellable, created["requestId"], "withdrawn")
    # Rollback removes the asker's withdrawals rather than relabelling them.
    run_sql(cancellable, CANCEL_ROLLBACK)
    [check] = status_checks(cancellable)
    assert check["conname"] == "drive_live_query_requests_status_check"
    assert "'cancelled'" not in check["definition"]
    with cancellable.db.engine.connect() as connection:
        remaining = connection.execute(
            text("SELECT count(*) FROM drive_live_query_requests WHERE request_id=:id"),
            {"id": created["requestId"]},
        ).scalar_one()
    assert remaining == 0
    run_sql(cancellable, CANCEL_MIGRATION)
    [check] = status_checks(cancellable)
    assert "'cancelled'" in check["definition"]


async def test_the_asker_cancels_a_pending_question_without_reading_drive(cancellable, no_drive):
    queries = service(cancellable, no_drive)
    created = await ask(cancellable)
    cancelled = await queries.cancel(
        user_id="recipient", request_id=created["requestId"], revision=created["revision"]
    )
    assert cancelled["status"] == "cancelled" and cancelled["direction"] == "outgoing"
    assert cancelled["decidedAt"] is not None and cancelled["answer"] is None
    assert cancelled["revision"] == created["revision"] + 1
    owner_view = await queries.status(user_id="owner", request_id=created["requestId"])
    assert owner_view["status"] == "cancelled" and owner_view["canDecide"] is False
    assert owner_view["lastError"] is None
    with pytest.raises(DriveSharingError, match="request_already_decided"):
        await queries.allow(
            user_id="owner",
            request_id=created["requestId"],
            revision=owner_view["revision"],
            consent_token=OWNER_PROOF,
        )
    with pytest.raises(DriveSharingError, match="request_already_decided"):
        await queries.deny(
            user_id="owner", request_id=created["requestId"], revision=owner_view["revision"]
        )
    # A retried withdrawal with the stale revision is idempotent.
    again = await queries.cancel(
        user_id="recipient", request_id=created["requestId"], revision=created["revision"]
    )
    assert again["status"] == "cancelled" and again["revision"] == cancelled["revision"]
    assert row(cancellable, created["requestId"])["answer_envelope"] is None
    assert no_drive.untouched()


async def test_only_the_asker_can_cancel(cancellable, no_drive):
    queries = service(cancellable, no_drive)
    created = await ask(cancellable)
    for user in ("owner", "stranger"):
        with pytest.raises(DriveSharingError, match="request_unavailable"):
            await queries.cancel(
                user_id=user, request_id=created["requestId"], revision=created["revision"]
            )
    assert row(cancellable, created["requestId"])["status"] == "pending"
    # Withdrawing never needs an active connection.
    disconnect(cancellable)
    cancelled = await queries.cancel(
        user_id="recipient", request_id=created["requestId"], revision=created["revision"]
    )
    assert cancelled["status"] == "cancelled"
    assert no_drive.untouched()


async def test_cancel_is_revision_bound_and_refuses_decided_or_expired_questions(cancellable):
    created = await ask(cancellable)
    with pytest.raises(DriveSharingError, match="request_changed"):
        await cancellable.cancel(
            user_id="recipient", request_id=created["requestId"], revision=created["revision"] + 5
        )
    await cancellable.deny(
        user_id="owner", request_id=created["requestId"], revision=created["revision"]
    )
    with pytest.raises(DriveSharingError, match="request_already_decided"):
        await cancellable.cancel(
            user_id="recipient", request_id=created["requestId"], revision=created["revision"] + 1
        )
    expired = await ask(cancellable)
    with cancellable.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_live_query_requests SET created_at=:old, expires_at=:gone "
                "WHERE request_id=:id"
            ),
            {
                "old": datetime.now(UTC) - timedelta(days=8),
                "gone": datetime.now(UTC) - timedelta(days=1),
                "id": expired["requestId"],
            },
        )
    with pytest.raises(DriveSharingError, match="request_expired"):
        await cancellable.cancel(
            user_id="recipient", request_id=expired["requestId"], revision=expired["revision"]
        )
    # An abandoned claim past its deadline reads as expired, so it cannot be cancelled either.
    stale_expired = await ask(cancellable)
    abandon(cancellable, stale_expired["requestId"], expired=True)
    view = await cancellable.status(user_id="recipient", request_id=stale_expired["requestId"])
    assert view["status"] == "expired"
    with pytest.raises(DriveSharingError, match="request_expired"):
        await cancellable.cancel(
            user_id="recipient",
            request_id=stale_expired["requestId"],
            revision=view["revision"],
        )


async def test_a_cancel_fences_claim_require_claim_and_complete(cancellable):
    created = await ask(cancellable)
    claim = await cancellable.claim(
        user_id="owner", request_id=created["requestId"], revision=created["revision"]
    )
    running = await cancellable.status(user_id="recipient", request_id=created["requestId"])
    assert running["status"] == "running"
    cancelled = await cancellable.cancel(
        user_id="recipient", request_id=created["requestId"], revision=running["revision"]
    )
    assert cancelled["status"] == "cancelled"
    with pytest.raises(PermissionError):
        await cancellable.require_claim(
            user_id="owner", request_id=created["requestId"], revision=claim["revision"]
        )
    with pytest.raises(DriveSharingError, match="request_changed"):
        await cancellable.complete(
            user_id="owner",
            request_id=created["requestId"],
            revision=claim["revision"],
            answer={"text": "private", "titles": ["x"]},
        )
    await cancellable.release(
        user_id="owner",
        request_id=created["requestId"],
        revision=claim["revision"],
        error_code="drive_query_unavailable",
    )
    with pytest.raises(DriveSharingError, match="request_already_decided"):
        await cancellable.claim(
            user_id="owner", request_id=created["requestId"], revision=cancelled["revision"]
        )
    stored = row(cancellable, created["requestId"])
    assert stored["status"] == "cancelled" and stored["answer_envelope"] is None
    assert stored["last_error_code"] is None


async def test_cancel_during_a_running_allow_stores_no_answer(cancellable, monkeypatch):
    async def find(**kwargs):
        running = await cancellable.status(user_id="recipient", request_id=created["requestId"])
        await cancellable.cancel(
            user_id="recipient", request_id=created["requestId"], revision=running["revision"]
        )
        return {"matches": [match()], "truncated": False}

    reader = fake_reader(find=AsyncMock(side_effect=find))
    chat = live_chat(monkeypatch, reader=reader, plan={"terms": ["bank"], "mode": "read"})
    created = await ask(cancellable)
    with pytest.raises((DriveSharingError, PermissionError)):
        await service(cancellable, chat).allow(
            user_id="owner",
            request_id=created["requestId"],
            revision=created["revision"],
            consent_token=OWNER_PROOF,
        )
    reader.find.assert_awaited_once()
    reader.read_matches.assert_not_awaited()
    stored = row(cancellable, created["requestId"])
    assert stored["status"] == "cancelled" and stored["answer_envelope"] is None
    seen = await cancellable.status(user_id="recipient", request_id=created["requestId"])
    assert seen["status"] == "cancelled" and seen["answer"] is None


async def test_consent_center_files_a_cancelled_question_under_history(cancellable):
    center = DriveSharingCenterContributor(db=cancellable.db)
    created = await ask(cancellable)
    await cancellable.cancel(
        user_id="recipient", request_id=created["requestId"], revision=created["revision"]
    )
    abandoned = await ask(cancellable)
    abandon(cancellable, abandoned["requestId"])
    view = await cancellable.status(user_id="recipient", request_id=abandoned["requestId"])
    assert view["status"] == "pending"
    await cancellable.cancel(
        user_id="recipient", request_id=abandoned["requestId"], revision=view["revision"]
    )
    expected = {(created["requestId"], "cancelled"), (abandoned["requestId"], "cancelled")}
    for user in ("owner", "recipient"):
        history = await center.page(user, bucket="history", limit=10)
        assert {(item["request_id"], item["status"]) for item in history["items"]} == expected
    assert (await center.counts("owner"))["incoming_requests"] == 0
    assert (await center.counts("recipient"))["outgoing_requests"] == 0


async def test_a_revoked_google_grant_asks_the_owner_to_reconnect(cancellable, monkeypatch):
    chat = DriveChatService(
        oauth=SimpleNamespace(
            current_credential=AsyncMock(
                side_effect=DriveOAuthError("grant_rejected", status_code=401)
            )
        ),
        search_planner=AsyncMock(side_effect=AssertionError("planner reached")),
    )
    created = await ask(cancellable)
    with pytest.raises(DriveSharingError, match="reconnect_required") as raised:
        await service(cancellable, chat).allow(
            user_id="owner",
            request_id=created["requestId"],
            revision=created["revision"],
            consent_token=OWNER_PROOF,
        )
    assert raised.value.retryable is False
    view = await cancellable.status(user_id="owner", request_id=created["requestId"])
    assert view["status"] == "pending" and view["lastError"] == "reconnect_required"
    requester = await cancellable.status(user_id="recipient", request_id=created["requestId"])
    assert requester["lastError"] is None


async def test_allowing_a_question_never_runs_the_permission_executor(cancellable, monkeypatch):
    grant = AsyncMock(return_value="succeeded")
    reconcile = AsyncMock(return_value="succeeded")
    monkeypatch.setattr(DrivePermissionExecutor, "grant", grant)
    monkeypatch.setattr(DrivePermissionExecutor, "reconcile", reconcile)
    reader = fake_reader()
    chat = live_chat(monkeypatch, reader=reader, plan={"terms": ["bank"], "mode": "find"})
    created = await ask(cancellable)
    answered = await service(cancellable, chat).allow(
        user_id="owner",
        request_id=created["requestId"],
        revision=created["revision"],
        consent_token=OWNER_PROOF,
    )
    assert answered["status"] == "answered"
    assert not grant.called and not reconcile.called
    with cancellable.db.engine.connect() as connection:
        for table in ("drive_share_permission_operations", "drive_share_requests"):
            assert connection.execute(text(f"SELECT count(*) FROM {table}")).scalar_one() == 0  # noqa: S608


async def test_a_second_question_needs_its_own_allow(cancellable, monkeypatch):
    reader = fake_reader()
    chat = live_chat(monkeypatch, reader=reader, plan={"terms": ["bank"], "mode": "find"})
    queries = service(cancellable, chat)
    first = await ask(cancellable, query="march bank statement")
    answered = await queries.allow(
        user_id="owner",
        request_id=first["requestId"],
        revision=first["revision"],
        consent_token=OWNER_PROOF,
    )
    assert answered["status"] == "answered"
    assert reader.find.await_count == 1
    second = await ask(cancellable, query="april salary slip")
    assert second["requestId"] != first["requestId"] and second["status"] == "pending"
    # Nothing is read for the second question before its own Allow.
    assert reader.find.await_count == 1
    owner_view = await queries.status(user_id="owner", request_id=second["requestId"])
    assert owner_view["canDecide"] is True
    await queries.allow(
        user_id="owner",
        request_id=second["requestId"],
        revision=second["revision"],
        consent_token=OWNER_PROOF,
    )
    assert reader.find.await_count == 2
    prompt = json.loads(chat.search_planner.await_args_list[1].kwargs["prompt"])
    assert prompt["document_request"]["purpose"] == "april salary slip"
    first_view = await queries.status(user_id="recipient", request_id=first["requestId"])
    # The asker sees the stored answer without the owner-only file list.
    assert "files" not in first_view["answer"]
    assert first_view["answer"] == {
        key: value
        for key, value in answered["answer"].items()
        if key not in {"files", "selectedFileRefs"}
    }
    with pytest.raises(DriveSharingError, match="request_already_decided"):
        await queries.allow(
            user_id="owner",
            request_id=first["requestId"],
            revision=answered["revision"],
            consent_token=OWNER_PROOF,
        )
    assert reader.find.await_count == 2
