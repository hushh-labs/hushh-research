"""The owner shares their own Drive files with a connection, from chat.

Real isolated PostgreSQL. The guarantees under test: the owner's tap runs one
live search under the owner's authority and seals what it found; a retried tap
does not search again; a share binds only files from that search, by
reference, to the connected recipient through the existing exact-file lane;
the recipient never sees the search.
"""

# ruff: noqa: F811 -- shared pytest fixture imports

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_live_query_service import DriveLiveQueryService
from hushh_mcp.services.drive_owner_share_store import DriveOwnerShareStore
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_sharing_retention import erase_drive_account_in_transaction
from tests.services.test_drive_document_selection import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
)
from tests.services.test_drive_sharing_store import MIGRATIONS, sharing  # noqa: F401

FILE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345"
FOLDER_ID = "1FolderFolderFolderFolderFolder00"
SHARE_ID = "55555555-5555-4555-8555-555555555555"
OWNER_PROOF = "synthetic-owner-proof"
WORDS = "Chris onboarding recordings"


@pytest.fixture
async def shares(sharing, monkeypatch):
    monkeypatch.setenv("GOOGLE_DRIVE_CHAT_READS", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner,recipient,stranger")
    with sharing.db.engine.connect() as connection:
        with connection.connection.driver_connection.cursor() as cursor:
            # Replay mode runs every migration on every deploy.
            for _ in range(2):
                cursor.execute((MIGRATIONS / "245_drive_owner_shares.sql").read_text())
        connection.execute(
            text("CREATE TABLE actor_identity_cache(user_id TEXT PRIMARY KEY,display_name TEXT)")
        )
        connection.execute(
            text("INSERT INTO actor_identity_cache VALUES ('owner','Ada'),('recipient','Bo')")
        )
        connection.commit()
    return DriveOwnerShareStore(db=sharing.db)


def found(*extra):
    return [
        {
            "file_id": FILE_ID,
            "name": "Chris onboarding - Recording.mp4",
            "mime_type": "video/mp4",
            "modified_time": "2026-09-24T18:00:00Z",
        },
        *extra,
    ]


def chat(status="ok", files=None, answer=None):
    return SimpleNamespace(
        run_live_query=AsyncMock(
            return_value={
                "status": status,
                "answer": answer,
                "share_files": found() if files is None else files,
            }
        )
    )


def sharing_doubles():
    sharing = SimpleNamespace(
        store=SimpleNamespace(
            create_request=AsyncMock(return_value={"requestId": SHARE_ID}),
            request_status=AsyncMock(return_value={"revision": 1}),
            decline_or_cancel=AsyncMock(),
        ),
        review=AsyncMock(
            return_value={
                "status": "review_ready",
                "canApprove": True,
                "revision": 2,
                "reviewDigest": "d" * 64,
                "files": [{"documentId": str(uuid4())}],
            }
        ),
        approve=AsyncMock(return_value={"status": "approved"}),
    )
    suggestions = SimpleNamespace(run_one=AsyncMock(return_value="review_ready"))
    return sharing, suggestions


def service(shares, live, owner=None, sharing=None, suggestions=None):
    return DriveLiveQueryService(
        chat=live,
        owner_shares=shares,
        require_owner=owner or AsyncMock(),
        sharing=(lambda _owner: sharing) if sharing else None,
        suggestions=(lambda _owner: suggestions) if suggestions else None,
        recipient_identity=AsyncMock(return_value=SimpleNamespace(user_id="recipient")),
    )


async def prepare(queries, client=None, recipient="recipient"):
    return await queries.prepare_owner_share(
        user_id="owner",
        recipient_user_id=recipient,
        client_request_id=client or str(uuid4()),
        query=WORDS,
        consent_token=OWNER_PROOF,
        timezone="Asia/Kolkata",
    )


async def test_one_search_under_the_owner_authority_is_sealed_by_reference(shares):
    live = chat()
    view = await prepare(service(shares, live))
    kwargs = live.run_live_query.await_args.kwargs
    assert kwargs["user_id"] == "owner" and kwargs["query"] == WORDS
    assert kwargs["consent_token"] == OWNER_PROOF and kwargs["require_live"] is True
    assert view["status"] == "ready" and view["recipientName"] == "Bo"
    assert view["files"] == [
        {
            "ref": "f1",
            "name": "Chris onboarding - Recording.mp4",
            "modifiedTime": "2026-09-24T18:00:00Z",
        }
    ]
    # The owner's view names files by reference, never by Drive id.
    assert FILE_ID not in json.dumps(view)
    with shares.db.engine.connect() as connection:
        stored = json.dumps(
            dict(connection.execute(text("SELECT * FROM drive_owner_shares")).mappings().one()),
            default=str,
        )
    assert FILE_ID not in stored and WORDS not in stored


async def test_a_retried_tap_returns_the_first_search_without_searching_again(shares):
    live = chat()
    queries = service(shares, live)
    client = str(uuid4())
    first = await prepare(queries, client=client)
    again = await prepare(queries, client=client)
    assert again == first
    live.run_live_query.assert_awaited_once()


async def test_nothing_found_stores_nothing_and_keeps_the_owner_words(shares):
    queries = service(shares, chat(status="input_required", files=[], answer="Which file?"))
    view = await prepare(queries)
    assert view == {"requestId": None, "status": "no_match", "files": [], "message": "Which file?"}
    folders_only = service(
        shares,
        chat(
            files=[
                {
                    "file_id": FOLDER_ID,
                    "name": "Recordings",
                    "mime_type": "application/vnd.google-apps.folder",
                    "modified_time": None,
                }
            ]
        ),
    )
    assert (await prepare(folders_only))["status"] == "no_match"
    with shares.db.engine.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM drive_owner_shares")).scalar_one() == 0


async def test_only_a_connected_person_can_be_shared_with(shares):
    with pytest.raises(DriveSharingError, match="connection_required"):
        await prepare(service(shares, chat()), recipient="stranger")


async def test_the_owner_shares_chosen_files_with_the_connection_as_viewer(shares):
    sharing, suggestions = sharing_doubles()
    queries = service(shares, chat(), sharing=sharing, suggestions=suggestions)
    view = await prepare(queries)
    shared = await queries.share_owner_files(
        user_id="owner", request_id=view["requestId"], file_refs=["f1"]
    )
    queries.recipient_identity.assert_awaited_once_with("recipient")
    created = sharing.store.create_request.await_args.kwargs
    assert created["owner_user_id"] == "owner" and created["owner_initiated"] is True
    assert created["purpose"].purpose == WORDS
    suggestions.run_one.assert_awaited_once_with(
        user_id="owner",
        request_id=SHARE_ID,
        owner_selected=[
            {
                "file_id": FILE_ID,
                "name": "Chris onboarding - Recording.mp4",
                "mime_type": "video/mp4",
                "modified_time": "2026-09-24T18:00:00Z",
            }
        ],
    )
    assert sharing.approve.await_args.kwargs["confirmed"] is True
    assert shared["status"] == "shared" and shared["shareRequestId"] == SHARE_ID
    with pytest.raises(DriveSharingError, match="request_already_decided"):
        await queries.share_owner_files(
            user_id="owner", request_id=view["requestId"], file_refs=["f1"]
        )


@pytest.mark.parametrize("refs", [["f2"], ["f1", "f1"], []])
async def test_only_files_from_the_search_can_be_shared(shares, refs):
    sharing, suggestions = sharing_doubles()
    queries = service(shares, chat(), sharing=sharing, suggestions=suggestions)
    view = await prepare(queries)
    with pytest.raises(DriveSharingError):
        await queries.share_owner_files(
            user_id="owner", request_id=view["requestId"], file_refs=refs
        )
    sharing.store.create_request.assert_not_awaited()


async def test_another_owner_cannot_share_from_this_search(shares):
    sharing, suggestions = sharing_doubles()
    queries = service(shares, chat(), sharing=sharing, suggestions=suggestions)
    view = await prepare(queries)
    with pytest.raises(DriveSharingError, match="request_unavailable"):
        await queries.share_owner_files(
            user_id="recipient", request_id=view["requestId"], file_refs=["f1"]
        )


async def test_an_expired_search_cannot_be_shared(shares):
    sharing, suggestions = sharing_doubles()
    queries = service(shares, chat(), sharing=sharing, suggestions=suggestions)
    view = await prepare(queries)
    with shares.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_owner_shares SET expires_at=now()-INTERVAL '1 minute'")
        )
    with pytest.raises(DriveSharingError, match="owner_share_expired"):
        await queries.share_owner_files(
            user_id="owner", request_id=view["requestId"], file_refs=["f1"]
        )


async def test_a_failed_share_leaves_the_search_shareable(shares):
    sharing, suggestions = sharing_doubles()
    suggestions.run_one.return_value = "unavailable"
    queries = service(shares, chat(), sharing=sharing, suggestions=suggestions)
    view = await prepare(queries)
    with pytest.raises(DriveSharingError, match="drive_share_unavailable"):
        await queries.share_owner_files(
            user_id="owner", request_id=view["requestId"], file_refs=["f1"]
        )
    # The failed attempt's request is closed; the search itself stays ready.
    sharing.store.decline_or_cancel.assert_awaited_once()
    suggestions.run_one.return_value = "review_ready"
    shared = await queries.share_owner_files(
        user_id="owner", request_id=view["requestId"], file_refs=["f1"]
    )
    assert shared["status"] == "shared"


@pytest.mark.parametrize("user", ["owner", "recipient"])
async def test_either_account_erasure_removes_the_search(shares, user):
    await prepare(service(shares, chat()))
    with shares.db.engine.begin() as connection:
        erase_drive_account_in_transaction(connection, user_id=user, permanent=True)
        assert connection.execute(text("SELECT count(*) FROM drive_owner_shares")).scalar_one() == 0


@pytest.mark.parametrize("status", ["unavailable", "source_changed"])
async def test_a_failed_search_is_a_retryable_failure_not_no_match(shares, status):
    """Review 2026-09-25: a Vertex 429 or timeout read as "No matching files found"."""
    with pytest.raises(DriveSharingError, match="drive_query_unavailable") as raised:
        await prepare(service(shares, chat(status=status, files=[])))
    assert raised.value.retryable is True
    with shares.db.engine.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM drive_owner_shares")).scalar_one() == 0


async def test_an_expired_search_is_searched_again_on_the_next_tap(shares):
    live = chat()
    queries = service(shares, live)
    client = str(uuid4())
    first = await prepare(queries, client=client)
    with shares.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_owner_shares SET expires_at=now()-INTERVAL '1 minute'")
        )
    again = await prepare(queries, client=client)
    assert live.run_live_query.await_count == 2
    assert again["requestId"] != first["requestId"] and again["status"] == "ready"


# --- Trusted circle ---------------------------------------------------------

CIRCLE_ID = "66666666-6666-4666-8666-666666666666"


@pytest.fixture
async def circle(shares, monkeypatch):
    """A Trusted circle holding each kind of connection the product creates."""
    monkeypatch.setenv(
        "CONNECTOR_INTERNAL_OWNER_COHORT", "owner,recipient,contact,comember,stranger,nogoogle"
    )
    with shares.db.engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE one_location_circles(id UUID PRIMARY KEY,owner_user_id TEXT,"
                "system_kind TEXT,status TEXT)"
            )
        )
        connection.execute(
            text(
                "CREATE TABLE one_location_circle_memberships(circle_id UUID,user_id TEXT,"
                "status TEXT)"
            )
        )
        connection.execute(
            text(
                "CREATE TABLE connection_origins(id UUID PRIMARY KEY,connection_id UUID,"
                "origin_kind TEXT,status TEXT)"
            )
        )
        connection.execute(
            text("INSERT INTO one_location_circles VALUES (:id,'owner','trusted','active')"),
            {"id": CIRCLE_ID},
        )
        origins = {
            "recipient": "direct_request",  # the owner accepted a request
            "nogoogle": "direct_request",
            "contact": "contact_sync",  # auto-connected by someone's contact sync
            "comember": "circle_member",  # joined a circle, never asked
        }
        for member in ("recipient", "nogoogle", "contact", "comember", "stranger"):
            connection.execute(
                text("INSERT INTO one_location_circle_memberships VALUES (:c,:u,'active')"),
                {"c": CIRCLE_ID, "u": member},
            )
            if member in origins:
                connection_id = str(uuid4())
                if member != "recipient":  # the sharing fixture already connects recipient
                    connection.execute(
                        text("INSERT INTO connections VALUES (:id,'owner',:u,'active')"),
                        {"id": connection_id, "u": member},
                    )
                else:
                    connection_id = connection.execute(
                        text("SELECT id FROM connections WHERE user_b_id='recipient'")
                    ).scalar_one()
                connection.execute(
                    text("INSERT INTO connection_origins VALUES (:id,:c,:k,'active')"),
                    {"id": str(uuid4()), "c": connection_id, "k": origins[member]},
                )
    return shares


def circle_service(shares, live, **changes):
    queries = service(shares, live, **changes)

    async def identity(user_id):
        if user_id == "nogoogle":
            raise DriveSharingError("recipient_google_identity_required")
        return SimpleNamespace(user_id=user_id)

    queries.recipient_identity = AsyncMock(side_effect=identity)
    return queries


async def prepare_circle(queries, client=None):
    return await queries.prepare_trusted_share(
        user_id="owner",
        client_request_id=client or str(uuid4()),
        query=WORDS,
        consent_token=OWNER_PROOF,
        timezone="Asia/Kolkata",
    )


async def test_only_people_the_owner_accepted_can_receive_a_circle_share(circle):
    live = chat()
    view = await prepare_circle(circle_service(circle, live))
    assert view["status"] == "ready"
    assert [person["name"] for person in view["recipients"]] == ["Bo"]
    reasons = sorted(item["reason"] for item in view["excluded"])
    assert reasons == ["circle", "contacts", "no_google_account", "not_connected"]
    live.run_live_query.assert_awaited_once()
    with circle.db.engine.connect() as connection:
        recipients = [
            row[0]
            for row in connection.execute(text("SELECT recipient_user_id FROM drive_owner_shares"))
        ]
    # A contact-sync or circle-only connection never gets a row to share from.
    assert recipients == ["recipient"]
    assert FILE_ID not in json.dumps(view)


async def test_a_retried_circle_tap_returns_the_first_search(circle):
    live = chat()
    queries = circle_service(circle, live)
    client = str(uuid4())
    first = await prepare_circle(queries, client=client)
    again = await prepare_circle(queries, client=client)
    assert again["recipients"] == first["recipients"]
    live.run_live_query.assert_awaited_once()


async def test_no_eligible_person_searches_nothing(circle):
    with circle.db.engine.begin() as connection:
        connection.execute(text("UPDATE connection_origins SET origin_kind='contact_sync'"))
    live = chat()
    view = await prepare_circle(circle_service(circle, live))
    assert view["status"] == "no_recipients" and view["recipients"] == []
    live.run_live_query.assert_not_awaited()


async def test_each_circle_recipient_is_shared_through_their_own_lane(circle):
    sharing, suggestions = sharing_doubles()
    queries = circle_service(circle, chat(), sharing=sharing, suggestions=suggestions)
    view = await prepare_circle(queries)
    [person] = view["recipients"]
    shared = await queries.share_owner_files(
        user_id="owner", request_id=person["requestId"], file_refs=["f1"]
    )
    assert shared["status"] == "shared"
    assert sharing.store.create_request.await_args.kwargs["owner_initiated"] is True


async def test_a_pair_stored_in_database_order_still_counts_as_connected(shares, monkeypatch):
    """Postgres collation, not Python's sort, orders a connection's pair."""
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner,recipient,Mixed")
    with shares.db.engine.begin() as connection:
        connection.execute(
            text("INSERT INTO connections VALUES (:id,'owner','Mixed','active')"),
            {"id": str(uuid4())},
        )
        connection.execute(text("INSERT INTO actor_identity_cache VALUES ('Mixed','Mo')"))
    # Python would look for ('Mixed','owner'); the row is stored the other way.
    view = await prepare(service(shares, chat()), recipient="Mixed")
    assert view["status"] == "ready" and view["recipientName"] == "Mo"


async def test_a_firebase_blip_is_unavailable_not_no_google_and_a_retry_adds_them(circle):
    queries = circle_service(circle, chat())
    blip = {"on": True}

    async def identity(user_id):
        if user_id == "recipient" and blip["on"]:
            raise DriveSharingError("recipient_verification_unavailable", retryable=True)
        if user_id == "nogoogle":
            raise DriveSharingError("recipient_google_identity_required")
        return SimpleNamespace(user_id=user_id)

    queries.recipient_identity = AsyncMock(side_effect=identity)
    client = str(uuid4())
    first = await prepare_circle(queries, client=client)
    assert first["status"] == "no_recipients"
    assert {"name": "Bo", "reason": "unavailable"} in first["excluded"]
    blip["on"] = False
    again = await prepare_circle(queries, client=client)
    assert [person["name"] for person in again["recipients"]] == ["Bo"]


async def test_a_member_missing_from_an_earlier_search_is_added_from_its_files(circle):
    live = chat()
    queries = circle_service(circle, live)
    client = str(uuid4())
    await prepare_circle(queries, client=client)
    with circle.db.engine.begin() as connection:
        connection.execute(text("DELETE FROM drive_owner_shares"))
        # Keep one sealed search alive for another member, as if Bo's row expired.
        connection.execute(
            text("INSERT INTO connections VALUES (:id,'owner','late','active')"),
            {"id": str(uuid4())},
        )
    first = await prepare_circle(queries, client=client)
    assert [person["name"] for person in first["recipients"]] == ["Bo"]
    assert live.run_live_query.await_count == 2


async def test_two_searches_never_mix_in_one_group(shares):
    client = str(uuid4())
    await shares.create(
        user_id="owner",
        recipient_user_id="recipient",
        client_request_id=client,
        query=WORDS,
        owner_files=found(),
    )
    other = [{**found()[0], "file_id": "1ZzZzZzZzZzZzZzZzZzZzZzZzZzZz0000"}]
    with pytest.raises(DriveSharingError, match="request_changed"):
        await shares.create(
            user_id="owner",
            recipient_user_id="recipient",
            client_request_id=client,
            query=WORDS,
            owner_files=other,
        )
