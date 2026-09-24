"""B asks about A's Drive; A allows or denies. Real isolated PostgreSQL.

The guarantees under test: a question never reads Drive before Allow, Deny
never reads Drive, one Allow runs the owner's own live turn exactly once, and
the requester sees answer text and titles only.
"""

# ruff: noqa: F811 -- shared pytest fixture imports

import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services import drive_chat_service
from hushh_mcp.services.drive_chat_service import DriveChatService
from hushh_mcp.services.drive_live_query_service import (
    NO_CLEAR_MATCH,
    DriveLiveQueryService,
    requester_answer,
)
from hushh_mcp.services.drive_live_query_store import DriveLiveQueryStore
from hushh_mcp.services.drive_sharing_center_contributor import DriveSharingCenterContributor
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_sharing_retention import erase_drive_account_in_transaction
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_document_selection import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
)
from tests.services.test_drive_sharing_store import MIGRATIONS, sharing  # noqa: F401

QUESTION = "potential bank statement"
FILE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345"
OPEN_URL = f"https://drive.google.com/file/d/{FILE_ID}/view"
OWNER_PROOF = "synthetic-owner-proof"


@pytest.fixture
async def store(sharing, monkeypatch):
    monkeypatch.setenv("GOOGLE_DRIVE_CHAT_READS", "true")
    # A stranger is inside the feature cohort, so only the relationship and
    # ownership checks can refuse them.
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner,recipient,stranger")
    with sharing.db.engine.connect() as connection:
        with connection.connection.driver_connection.cursor() as cursor:
            cursor.execute((MIGRATIONS / "242_drive_live_query_requests.sql").read_text())
        connection.execute(
            text("CREATE TABLE actor_identity_cache(user_id TEXT PRIMARY KEY,display_name TEXT)")
        )
        connection.execute(
            text("INSERT INTO actor_identity_cache VALUES ('owner','Ada'),('recipient','Bo')")
        )
        connection.commit()
    return DriveLiveQueryStore(db=sharing.db)


@pytest.fixture
def no_drive(monkeypatch):
    """Spies on every Drive entrypoint of the live turn.

    The live turn deliberately converts unexpected errors into an honest
    "unavailable" answer, so a raising stub alone could be swallowed; tests
    assert on these spies instead.
    """
    spies = {
        name: Mock(side_effect=AssertionError(f"{name} reached"))
        for name in (
            "DriveLiveReader",
            "DriveDocumentReader",
            "get_external_connector_oauth_service",
        )
    }
    for name, spy in spies.items():
        monkeypatch.setattr(drive_chat_service, name, spy)
    planner = AsyncMock(side_effect=AssertionError("planner reached"))
    interpreter = AsyncMock(side_effect=AssertionError("interpreter reached"))
    chat = DriveChatService(search_planner=planner, interpreter=interpreter)
    chat.run_live_query = AsyncMock(wraps=chat.run_live_query)
    chat.untouched = lambda: (
        not any(spy.called for spy in spies.values())
        and not planner.called
        and not interpreter.called
        and not chat.run_live_query.called
    )
    return chat


def live_chat(monkeypatch, *, reader, plan, interpreter=None):
    monkeypatch.setattr(drive_chat_service, "DriveLiveReader", lambda **kwargs: reader)
    monkeypatch.setattr(
        drive_chat_service, "DriveDocumentReader", Mock(side_effect=AssertionError("selected lane"))
    )
    return DriveChatService(
        oauth=SimpleNamespace(current_credential=AsyncMock(return_value=({}, {"profile": "live"}))),
        search_planner=AsyncMock(return_value=plan),
        interpreter=interpreter or AsyncMock(side_effect=AssertionError("interpreter reached")),
    )


def match(name="March bank statement.pdf"):
    return {
        "file_id": FILE_ID,
        "name": name,
        "mime_type": "application/pdf",
        "modified_time": "2026-03-31T10:00:00Z",
        "open_url": OPEN_URL,
        "source_ref": "document:" + "a" * 32,
    }


def fake_reader(**changes):
    reader = SimpleNamespace(
        find=AsyncMock(return_value={"matches": [match()], "truncated": False}),
        read_matches=AsyncMock(side_effect=AssertionError("content read")),
        require_current=AsyncMock(),
    )
    for key, value in changes.items():
        setattr(reader, key, value)
    return reader


async def ask(store, query=QUESTION, client=None, requester="recipient"):
    return await store.create(
        requester_user_id=requester,
        owner_user_id="owner",
        client_request_id=client or str(uuid4()),
        query=query,
    )


def service(store, chat, owner=None):
    return DriveLiveQueryService(store=store, chat=chat, require_owner=owner or AsyncMock())


def row(store, request_id):
    with store.db.engine.connect() as connection:
        return dict(
            connection.execute(
                text("SELECT * FROM drive_live_query_requests WHERE request_id=:id"),
                {"id": request_id},
            )
            .mappings()
            .one()
        )


async def test_a_question_is_pending_sealed_and_idempotent(store):
    client = str(uuid4())
    created = await ask(store, client=client)
    assert created["status"] == "pending" and created["direction"] == "outgoing"
    assert created["query"] == QUESTION and created["counterpartName"] == "Ada"
    assert created["answer"] is None and created["canDecide"] is False
    stored = row(store, created["requestId"])
    assert QUESTION not in json.dumps(stored["query_envelope"])
    assert (await ask(store, client=client))["requestId"] == created["requestId"]
    with pytest.raises(DriveSharingError, match="request_changed"):
        await ask(store, query="something else", client=client)


async def test_a_question_needs_an_active_connection_and_a_bounded_text(store):
    with pytest.raises(DriveSharingError, match="connection_required"):
        await ask(store, requester="stranger")
    for query in ("   ", "x" * 2001, "€" * 700):
        with pytest.raises(DriveSharingError, match="invalid_argument"):
            await ask(store, query=query)


async def test_zero_drive_reads_before_allow_and_on_deny(store, no_drive):
    queries = service(store, no_drive)
    created = await queries.create(
        requester_user_id="recipient",
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        query=QUESTION,
    )
    incoming = await queries.list_requests(
        user_id="owner", direction="incoming", limit=20, offset=0
    )
    assert [item["requestId"] for item in incoming["items"]] == [created["requestId"]]
    owner_view = await queries.status(user_id="owner", request_id=created["requestId"])
    assert owner_view["canDecide"] is True and owner_view["counterpartName"] == "Bo"
    denied = await queries.deny(
        user_id="owner", request_id=created["requestId"], revision=owner_view["revision"]
    )
    assert denied["status"] == "denied" and denied["answer"] is None
    requester_view = await queries.status(user_id="recipient", request_id=created["requestId"])
    assert requester_view["status"] == "denied"
    assert no_drive.untouched()


async def test_allow_runs_the_live_turn_once_and_the_requester_sees_titles_only(store, monkeypatch):
    reader = fake_reader()
    chat = live_chat(
        monkeypatch, reader=reader, plan={"terms": ["bank", "statement"], "mode": "find"}
    )
    queries = service(store, chat)
    created = await ask(store)
    answered = await queries.allow(
        user_id="owner",
        request_id=created["requestId"],
        revision=created["revision"],
        consent_token=OWNER_PROOF,
        timezone="Asia/Kolkata",
    )
    assert answered["status"] == "answered"
    reader.find.assert_awaited_once()
    seen = await queries.status(user_id="recipient", request_id=created["requestId"])
    assert seen["status"] == "answered" and seen["canDecide"] is False
    assert seen["answer"]["titles"] == ["March bank statement.pdf"]
    shown = json.dumps(seen)
    assert FILE_ID not in shown and "drive.google.com" not in shown and "2026-03-31" not in shown
    with pytest.raises(DriveSharingError, match="request_already_decided"):
        await queries.allow(
            user_id="owner",
            request_id=created["requestId"],
            revision=answered["revision"],
            consent_token=OWNER_PROOF,
        )
    reader.find.assert_awaited_once()


async def test_allow_answers_with_the_cited_file_titles(store, monkeypatch):
    content = [
        {
            "source_ref": "document:" + "b" * 32,
            "document_ref": str(uuid4()),
            "name": "March bank statement.pdf",
            "page": None,
            "text": "Closing balance 1,204.55",
            "source_version": "7",
        }
    ]
    reader = fake_reader(
        read_matches=AsyncMock(
            return_value={"untrusted_external_content": content, "truncated": False}
        )
    )
    interpreter = AsyncMock(
        return_value={
            "answer": "The closing balance is 1,204.55.",
            "source_refs": ["document:" + "b" * 32],
        }
    )
    chat = live_chat(
        monkeypatch,
        reader=reader,
        plan={"terms": ["bank", "statement"], "mode": "read"},
        interpreter=interpreter,
    )
    created = await ask(store, query="what is my closing balance")
    answered = await service(store, chat).allow(
        user_id="owner",
        request_id=created["requestId"],
        revision=created["revision"],
        consent_token=OWNER_PROOF,
    )
    # The owner's view adds the shareable files (none here: the fake reader
    # records no rows) and whether they were shared yet.
    assert answered["answer"] == {
        "text": "The closing balance is 1,204.55.",
        "titles": ["March bank statement.pdf"],
        "truncated": False,
        "shareRequestId": None,
        "files": [],
    }
    # The interpreter answers the exact stored question under the owner's token.
    prompt = json.loads(interpreter.await_args.kwargs["prompt"])
    assert prompt["user_request"] == "what is my closing balance"
    assert interpreter.await_args.kwargs["consent_token"] == OWNER_PROOF


async def test_a_failed_run_returns_to_pending_with_an_owner_only_reason(store, monkeypatch):
    reader = fake_reader(find=AsyncMock(side_effect=DriveReadError("reconnect_required")))
    chat = live_chat(monkeypatch, reader=reader, plan={"terms": ["bank"], "mode": "find"})
    queries = service(store, chat)
    created = await ask(store)
    with pytest.raises(DriveSharingError, match="reconnect_required"):
        await queries.allow(
            user_id="owner",
            request_id=created["requestId"],
            revision=created["revision"],
            consent_token=OWNER_PROOF,
        )
    owner_view = await queries.status(user_id="owner", request_id=created["requestId"])
    assert owner_view["status"] == "pending" and owner_view["lastError"] == "reconnect_required"
    assert owner_view["canDecide"] is True
    requester_view = await queries.status(user_id="recipient", request_id=created["requestId"])
    assert requester_view["status"] == "pending" and requester_view["lastError"] is None
    # Allowed again after reconnecting: the same question runs once more.
    reader.find = AsyncMock(return_value={"matches": [match()], "truncated": False})
    answered = await queries.allow(
        user_id="owner",
        request_id=created["requestId"],
        revision=owner_view["revision"],
        consent_token=OWNER_PROOF,
    )
    assert answered["status"] == "answered" and answered["lastError"] is None


async def test_owner_revocation_mid_run_releases_the_claim(store, monkeypatch):
    reader = fake_reader()
    chat = live_chat(monkeypatch, reader=reader, plan={"terms": ["bank"], "mode": "find"})
    owner = AsyncMock(side_effect=[None, PermissionError("revoked")])
    created = await ask(store)
    with pytest.raises(PermissionError):
        await service(store, chat, owner).allow(
            user_id="owner",
            request_id=created["requestId"],
            revision=created["revision"],
            consent_token=OWNER_PROOF,
        )
    reader.find.assert_not_awaited()
    assert row(store, created["requestId"])["status"] == "pending"


async def test_allow_after_expiry_is_rejected_without_reads(store, no_drive):
    created = await ask(store)
    with store.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_live_query_requests SET created_at=:old, expires_at=:expired WHERE request_id=:id"
            ),
            {
                "old": datetime.now(UTC) - timedelta(days=8),
                "expired": datetime.now(UTC) - timedelta(days=1),
                "id": created["requestId"],
            },
        )
    assert (await store.status(user_id="recipient", request_id=created["requestId"]))[
        "status"
    ] == "expired"
    with pytest.raises(DriveSharingError, match="request_expired"):
        await service(store, no_drive).allow(
            user_id="owner",
            request_id=created["requestId"],
            revision=created["revision"],
            consent_token=OWNER_PROOF,
        )
    assert no_drive.untouched()


async def test_only_the_owner_decides_and_only_participants_can_read(store, no_drive):
    created = await ask(store)
    queries = service(store, no_drive)
    for user in ("recipient", "stranger"):
        with pytest.raises(DriveSharingError, match="request_unavailable"):
            await queries.allow(
                user_id=user,
                request_id=created["requestId"],
                revision=created["revision"],
                consent_token=OWNER_PROOF,
            )
        with pytest.raises(DriveSharingError, match="request_unavailable"):
            await queries.deny(
                user_id=user, request_id=created["requestId"], revision=created["revision"]
            )
    with pytest.raises(DriveSharingError, match="request_unavailable"):
        await queries.status(user_id="stranger", request_id=created["requestId"])
    assert no_drive.untouched()


async def test_a_claim_is_exclusive_fenced_and_reclaimable_when_abandoned(store):
    created = await ask(store)
    claim = await store.claim(
        user_id="owner", request_id=created["requestId"], revision=created["revision"]
    )
    assert claim["query"] == QUESTION
    await store.require_claim(
        user_id="owner", request_id=created["requestId"], revision=claim["revision"]
    )
    with pytest.raises(DriveSharingError, match="request_already_decided"):
        await store.claim(
            user_id="owner", request_id=created["requestId"], revision=claim["revision"]
        )
    with pytest.raises(DriveSharingError, match="request_already_decided"):
        await store.deny(
            user_id="owner", request_id=created["requestId"], revision=claim["revision"]
        )
    with pytest.raises(PermissionError):
        await store.require_claim(
            user_id="owner", request_id=created["requestId"], revision=claim["revision"] + 1
        )
    with store.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_live_query_requests SET decided_at=:old WHERE request_id=:id"),
            {"old": datetime.now(UTC) - timedelta(minutes=10), "id": created["requestId"]},
        )
    abandoned = await store.status(user_id="owner", request_id=created["requestId"])
    assert abandoned["status"] == "pending" and abandoned["canDecide"] is True
    again = await store.claim(
        user_id="owner", request_id=created["requestId"], revision=abandoned["revision"]
    )
    assert again["revision"] == abandoned["revision"] + 1
    with pytest.raises(PermissionError):
        # The first, abandoned run is fenced out by the new claim.
        await store.require_claim(
            user_id="owner", request_id=created["requestId"], revision=claim["revision"]
        )


async def test_consent_center_lists_questions_for_both_participants(store):
    created = await ask(store)
    center = DriveSharingCenterContributor(db=store.db)
    incoming = await center.page("owner", bucket="incoming_requests", limit=10)
    [entry] = [item for item in incoming["items"] if item["request_id"] == created["requestId"]]
    assert entry["id"] == f"drive_query_request:{created['requestId']}"
    assert entry["action"] == "DRIVE_QUERY_REVIEW" and entry["status"] == "pending"
    assert entry["metadata"]["request_source"] == "drive_live_query_request"
    assert QUESTION not in json.dumps(entry)
    outgoing = await center.counts("recipient")
    assert outgoing["outgoing_requests"] == 1
    await store.deny(user_id="owner", request_id=created["requestId"], revision=created["revision"])
    history = await center.page("owner", bucket="history", limit=10)
    assert [item["status"] for item in history["items"]] == ["denied"]
    assert (await center.counts("owner"))["incoming_requests"] == 0


async def test_either_participants_erasure_removes_the_question(store):
    for user in ("recipient", "owner"):
        created = await ask(store)
        with store.db.engine.begin() as connection:
            erase_drive_account_in_transaction(connection, user_id=user, permanent=True)
            remaining = connection.execute(
                text("SELECT count(*) FROM drive_live_query_requests WHERE request_id=:id"),
                {"id": created["requestId"]},
            ).scalar_one()
        assert remaining == 0


def test_requester_answer_withholds_links_dates_and_owner_instructions():
    files = {
        "status": "ok",
        "answer": None,
        "files": [match()],
        "unreadable": True,
        "found_truncated": False,
        "titles": ["March bank statement.pdf"],
        "truncated": True,
    }
    projected = requester_answer(files)
    assert projected["titles"] == ["March bank statement.pdf"]
    assert "couldn't be read" in projected["text"]
    assert FILE_ID not in json.dumps(projected) and "2026" not in json.dumps(projected)
    for status in ("input_required", "connect_required"):
        assert requester_answer({"status": status})["text"] == NO_CLEAR_MATCH


def abandon(store, request_id, *, expired=False):
    """Simulate an Allow whose process died mid-run (no release ran)."""
    now = datetime.now(UTC)
    with store.db.engine.begin() as connection:
        connection.execute(
            text("""
            UPDATE drive_live_query_requests
            SET status='running', revision=revision+1, decided_at=:old,
              created_at=:created, expires_at=:expires
            WHERE request_id=:id
        """),
            {
                "old": now - timedelta(minutes=10),
                "created": now - timedelta(days=8 if expired else 1),
                "expires": now - timedelta(days=1) if expired else now + timedelta(days=6),
                "id": request_id,
            },
        )


async def test_the_owner_can_still_deny_after_an_abandoned_allow(store, no_drive):
    created = await ask(store)
    abandon(store, created["requestId"])
    view = await store.status(user_id="owner", request_id=created["requestId"])
    assert view["status"] == "pending" and view["canDecide"] is True
    denied = await service(store, no_drive).deny(
        user_id="owner", request_id=created["requestId"], revision=view["revision"]
    )
    assert denied["status"] == "denied"
    assert no_drive.untouched()


async def test_consent_center_agrees_with_the_view_for_abandoned_claims(store):
    center = DriveSharingCenterContributor(db=store.db)
    live = await ask(store)
    abandon(store, live["requestId"])
    stale_expired = await ask(store)
    abandon(store, stale_expired["requestId"], expired=True)
    assert (await store.status(user_id="owner", request_id=stale_expired["requestId"]))[
        "status"
    ] == "expired"
    incoming = await center.page("owner", bucket="incoming_requests", limit=10)
    assert [item["request_id"] for item in incoming["items"]] == [live["requestId"]]
    history = await center.page("owner", bucket="history", limit=10)
    assert [(item["request_id"], item["status"]) for item in history["items"]] == [
        (stale_expired["requestId"], "expired")
    ]


async def test_consent_center_search_uses_the_question_card_wording(store):
    created = await ask(store)
    center = DriveSharingCenterContributor(db=store.db)
    for query in ("drive question", "DRIVE_QUERY_REVIEW", "google drive question"):
        found = await center.page("owner", bucket="incoming_requests", limit=10, query=query)
        assert [item["request_id"] for item in found["items"]] == [created["requestId"]]
    for query in ("document request", "DOCUMENT_SHARE_REVIEW", "google drive files"):
        found = await center.page("owner", bucket="incoming_requests", limit=10, query=query)
        assert found["items"] == []


def test_the_projection_and_the_store_share_one_stale_claim_bound():
    from hushh_mcp.services import drive_sharing_center_contributor as center
    from hushh_mcp.services.drive_live_query_store import STALE_CLAIM_SECONDS

    assert f"interval '{STALE_CLAIM_SECONDS} seconds'" in center._QUERIES


def disconnect(store):
    with store.db.engine.begin() as connection:
        connection.execute(text("UPDATE connections SET status='removed'"))


async def test_a_disconnect_during_the_run_releases_no_answer(store, monkeypatch):
    async def find(**kwargs):
        disconnect(store)
        return {"matches": [match()], "truncated": False}

    reader = fake_reader(find=AsyncMock(side_effect=find))
    chat = live_chat(monkeypatch, reader=reader, plan={"terms": ["bank"], "mode": "find"})
    created = await ask(store)
    with pytest.raises(DriveSharingError, match="connection_required"):
        await service(store, chat).allow(
            user_id="owner",
            request_id=created["requestId"],
            revision=created["revision"],
            consent_token=OWNER_PROOF,
        )
    stored = row(store, created["requestId"])
    assert stored["status"] == "pending" and stored["answer_envelope"] is None


async def test_the_answer_is_stored_only_while_the_connection_is_active(store):
    created = await ask(store)
    claim = await store.claim(
        user_id="owner", request_id=created["requestId"], revision=created["revision"]
    )
    disconnect(store)
    with pytest.raises(DriveSharingError, match="connection_required"):
        await store.complete(
            user_id="owner",
            request_id=created["requestId"],
            revision=claim["revision"],
            answer={"text": "private", "titles": ["x"]},
        )
    assert row(store, created["requestId"])["answer_envelope"] is None


async def test_a_selected_files_connection_asks_the_owner_to_reconnect(store, monkeypatch):
    monkeypatch.setattr(
        drive_chat_service,
        "DriveDocumentReader",
        Mock(side_effect=AssertionError("selected-file lane reached")),
    )
    chat = DriveChatService(
        oauth=SimpleNamespace(
            current_credential=AsyncMock(return_value=({}, {"profile": "selected"}))
        ),
        search_planner=AsyncMock(side_effect=AssertionError("planner reached")),
    )
    created = await ask(store)
    with pytest.raises(DriveSharingError, match="reconnect_required"):
        await service(store, chat).allow(
            user_id="owner",
            request_id=created["requestId"],
            revision=created["revision"],
            consent_token=OWNER_PROOF,
        )
    view = await store.status(user_id="owner", request_id=created["requestId"])
    assert view["status"] == "pending" and view["lastError"] == "reconnect_required"


SHARE_ID = "55555555-5555-4555-8555-555555555555"
SHARED_DOCUMENT = "66666666-6666-4666-8666-666666666666"


async def answered_question(store, monkeypatch):
    chat = live_chat(monkeypatch, reader=fake_reader(), plan={"terms": ["bank"], "mode": "find"})
    created = await ask(store)
    await service(store, chat).allow(
        user_id="owner",
        request_id=created["requestId"],
        revision=created["revision"],
        consent_token=OWNER_PROOF,
    )
    return created["requestId"]


def sharing_doubles(*, can_approve=True, prepared="review_ready"):
    sharing = SimpleNamespace(
        store=SimpleNamespace(
            create_request=AsyncMock(return_value={"requestId": SHARE_ID}),
            request_status=AsyncMock(return_value={"revision": 1}),
            decline_or_cancel=AsyncMock(),
        ),
        review=AsyncMock(
            return_value={
                "status": "review_ready" if can_approve else "approved",
                "canApprove": can_approve,
                "revision": 2,
                "reviewDigest": "d" * 64,
                "files": [{"documentId": SHARED_DOCUMENT}],
            }
        ),
        approve=AsyncMock(return_value={"status": "approved"}),
    )
    suggestions = SimpleNamespace(run_one=AsyncMock(return_value=prepared))
    recipient = SimpleNamespace(user_id="recipient")
    return sharing, suggestions, AsyncMock(return_value=recipient)


def sharing_service(store, sharing, suggestions, identity, owner=None):
    return DriveLiveQueryService(
        store=store,
        chat=SimpleNamespace(),
        require_owner=owner or AsyncMock(),
        sharing=lambda _owner: sharing,
        suggestions=lambda _owner: suggestions,
        recipient_identity=identity,
    )


async def test_the_owner_sees_the_found_files_and_the_asker_never_does(store, monkeypatch):
    request_id = await answered_question(store, monkeypatch)
    mine = await store.status(user_id="owner", request_id=request_id)
    assert mine["answer"]["files"] == [
        {"ref": "f1", "name": "March bank statement.pdf", "modifiedTime": "2026-03-31T10:00:00Z"}
    ]
    # Even the owner's view carries a reference, never the Drive file id.
    assert FILE_ID not in json.dumps(mine)
    theirs = await store.status(user_id="recipient", request_id=request_id)
    assert "files" not in theirs["answer"]
    shown = json.dumps(theirs)
    assert FILE_ID not in shown and "ownerFiles" not in shown and "2026-03-31" not in shown


async def test_the_owner_shares_chosen_files_with_the_asker_as_viewer(store, monkeypatch):
    from uuid import UUID

    request_id = await answered_question(store, monkeypatch)
    sharing, suggestions, identity = sharing_doubles()
    queries = sharing_service(store, sharing, suggestions, identity)
    shared = await queries.share(user_id="owner", request_id=request_id, file_refs=["f1"])
    identity.assert_awaited_once_with("recipient")
    created = sharing.store.create_request.await_args.kwargs
    assert created["owner_user_id"] == "owner"
    assert created["purpose"].purpose == QUESTION
    # A fresh, unguessable request per attempt, created as the owner's own share.
    assert UUID(created["client_request_id"]).version == 4
    assert created["owner_initiated"] is True
    suggestions.run_one.assert_awaited_once_with(
        user_id="owner",
        request_id=SHARE_ID,
        owner_selected=[
            {
                "file_id": FILE_ID,
                "name": "March bank statement.pdf",
                "mime_type": "application/pdf",
                "modified_time": "2026-03-31T10:00:00Z",
            }
        ],
    )
    sharing.approve.assert_awaited_once_with(
        user_id="owner",
        request_id=SHARE_ID,
        revision=2,
        review_digest="d" * 64,
        document_ids=[SHARED_DOCUMENT],
        confirmed=True,
    )
    assert shared["answer"]["shareRequestId"] == SHARE_ID
    theirs = await store.status(user_id="recipient", request_id=request_id)
    assert theirs["answer"]["shareRequestId"] == SHARE_ID
    with pytest.raises(DriveSharingError, match="request_already_decided"):
        await queries.share(user_id="owner", request_id=request_id, file_refs=["f1"])


async def test_a_trust_rule_approval_is_not_approved_twice(store, monkeypatch):
    request_id = await answered_question(store, monkeypatch)
    sharing, suggestions, identity = sharing_doubles(can_approve=False)
    shared = await sharing_service(store, sharing, suggestions, identity).share(
        user_id="owner", request_id=request_id, file_refs=["f1"]
    )
    sharing.approve.assert_not_awaited()
    assert shared["answer"]["shareRequestId"] == SHARE_ID


@pytest.mark.parametrize("refs", [["f2"], ["f1", "f1"], []])
async def test_only_files_from_the_answer_can_be_shared(store, monkeypatch, refs):
    request_id = await answered_question(store, monkeypatch)
    sharing, suggestions, identity = sharing_doubles()
    with pytest.raises(DriveSharingError):
        await sharing_service(store, sharing, suggestions, identity).share(
            user_id="owner", request_id=request_id, file_refs=refs
        )
    sharing.store.create_request.assert_not_awaited()
    identity.assert_not_awaited()


async def test_nothing_is_shared_from_a_pending_question_or_by_the_asker(store):
    created = await ask(store)
    sharing, suggestions, identity = sharing_doubles()
    queries = sharing_service(store, sharing, suggestions, identity)
    with pytest.raises(DriveSharingError, match="request_changed"):
        await queries.share(user_id="owner", request_id=created["requestId"], file_refs=["f1"])
    with pytest.raises(DriveSharingError, match="request_unavailable"):
        await queries.share(user_id="recipient", request_id=created["requestId"], file_refs=["f1"])
    sharing.store.create_request.assert_not_awaited()
    suggestions.run_one.assert_not_awaited()


async def test_sharing_needs_current_owner_authority(store, monkeypatch):
    request_id = await answered_question(store, monkeypatch)
    sharing, suggestions, identity = sharing_doubles()
    denied = AsyncMock(side_effect=PermissionError("locked"))
    with pytest.raises(PermissionError):
        await sharing_service(store, sharing, suggestions, identity, owner=denied).share(
            user_id="owner", request_id=request_id, file_refs=["f1"]
        )
    identity.assert_not_awaited()
    sharing.store.create_request.assert_not_awaited()


async def test_a_failed_share_is_declined_and_a_retry_starts_fresh(store, monkeypatch):
    request_id = await answered_question(store, monkeypatch)
    sharing, suggestions, identity = sharing_doubles()
    suggestions.run_one.side_effect = ["no_ready_files", "review_ready"]
    queries = sharing_service(store, sharing, suggestions, identity)
    with pytest.raises(DriveSharingError, match="drive_share_unavailable"):
        await queries.share(user_id="owner", request_id=request_id, file_refs=["f1"])
    # The failed attempt's request is closed, so nothing can prepare or share it later.
    sharing.store.decline_or_cancel.assert_awaited_once_with(
        user_id="owner", request_id=SHARE_ID, revision=1, decision="declined"
    )
    sharing.approve.assert_not_awaited()
    shared = await queries.share(user_id="owner", request_id=request_id, file_refs=["f1"])
    assert shared["answer"]["shareRequestId"] == SHARE_ID
    first, second = (
        call.kwargs["client_request_id"] for call in sharing.store.create_request.await_args_list
    )
    assert first != second


async def test_folders_are_never_offered_for_sharing(store, monkeypatch):
    folder = {
        **match("Statements folder"),
        "file_id": "1FolderFolderFolderFolderFolder00",
        "mime_type": "application/vnd.google-apps.folder",
    }
    reader = fake_reader(
        find=AsyncMock(return_value={"matches": [match(), folder], "truncated": False})
    )
    chat = live_chat(monkeypatch, reader=reader, plan={"terms": ["bank"], "mode": "find"})
    created = await ask(store)
    await service(store, chat).allow(
        user_id="owner",
        request_id=created["requestId"],
        revision=created["revision"],
        consent_token=OWNER_PROOF,
    )
    mine = await store.status(user_id="owner", request_id=created["requestId"])
    assert [item["name"] for item in mine["answer"]["files"]] == ["March bank statement.pdf"]
