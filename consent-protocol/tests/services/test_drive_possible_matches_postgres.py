"""D3 on real PostgreSQL: possible matches wait for the owner's Send, never the requester's eyes."""

# ruff: noqa: F401, F811 -- isolated PostgreSQL fixtures imported from their owners

import json
from datetime import UTC, date, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services import drive_request_bulk_service as bulk_service_module
from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
from hushh_mcp.services.drive_match_evidence import (
    CONTENT,
    CORRECTED,
    OWNER_SENT_FIELD,
    SYNONYM,
    WALK,
    possible_match_fields,
)
from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_possible_matches import DrivePossibleMatchesStore
from hushh_mcp.services.drive_request_brain import interpret_request
from hushh_mcp.services.drive_request_review_policy import AUTOSHARE_SELECTION_POLICY
from hushh_mcp.services.drive_sharing_contract import DriveSharingError, VerifiedGoogleRecipient
from hushh_mcp.services.drive_trusted_auto_service import DriveTrustedAutoService
from tests.services.test_drive_request_bulk_postgres import _recipient, _settle, request_bulk
from tests.services.test_drive_sharing_store import (
    MIGRATIONS,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    sharing,
)
from tests.services.test_drive_trusted_auto import _membership, _request

PURPOSE = "Standup notes from last 3 months"
DOC = "application/vnd.google-apps.document"

TITLE_1 = {"name": "Standup notes 2026-09-01.pdf"}
TITLE_2 = {"name": "Standup notes 2026-09-08.pdf"}
# Found only by content: the requester's words are not in its title.
CONTENT_HIT = {"name": "Weekly sync agenda.pdf", **possible_match_fields(CONTENT)}
# A loose synonym ("recap") names it, never the typed "notes".
SYNONYM_HIT = {"name": "Stand up recap Sep.pdf", **possible_match_fields(SYNONYM)}
# No tag at all and no title evidence: the claim-time title gate catches it.
UNTAGGED_HIT = {"name": "Q3 roadmap.pdf"}
# A gear's tag wins even over a matching title.
WALK_HIT = {"name": "Standup notes from the team folder.pdf", **possible_match_fields(WALK)}
BLOCKED_HIT = {"name": "Standup agenda.pdf", "shareable": False, **possible_match_fields(CONTENT)}


def _autoshare_checkpoint(*, request_id, revision, period):
    brain = interpret_request(
        PURPOSE,
        now=datetime.now(UTC),
        picked_period=(date.fromisoformat(period[0]), date.fromisoformat(period[1])),
    )
    return {
        "done": True,
        "request": {"query": PURPOSE},
        "request_origin_id": request_id,
        "request_revision": revision,
        "request_shareability_version": 1,
        "request_selection_version": 2,
        "request_selection_policy": AUTOSHARE_SELECTION_POLICY,
        "request_time_intent": "document_coverage",
        "request_owner_review_required": False,
        "authority_mode": "trusted_auto",
        "agent_package_required": False,
        "requested_period": {"start": period[0], "end": period[1]},
        "request_brain": brain.as_checkpoint(),
        "request_notes": True,
        "request_subject_terms": [],
    }


def _seed_search(bulk, *, request_id, files, status="completed", patch=None):
    """One automatic request search with the given encrypted results."""
    job = str(uuid4())
    with bulk.db.engine.begin() as connection:
        request = connection.execute(
            text("""UPDATE drive_share_requests SET bulk_search_started_at=clock_timestamp()
            WHERE request_id=:request RETURNING revision,request_envelope"""),
            {"request": request_id},
        ).one()
        private = bulk._open(
            request.request_envelope, user_id="owner", resource_id=request_id, purpose="request"
        )
        purpose = private["purpose"]
        checkpoint = {
            **_autoshare_checkpoint(
                request_id=request_id,
                revision=request.revision,
                period=(purpose["periodStart"], purpose["periodEnd"]),
            ),
            **(patch or {}),
        }
        connection.execute(
            text("""INSERT INTO drive_owner_search_jobs(
              job_id,user_id,client_request_id,request_digest,connection_generation,
              consent_version,status,revision,matched,pages_scanned,incomplete_search,
              checkpoint_envelope)
              VALUES(:job,'owner',:client,:digest,1,'drive-owner-search-v1',
                :status,4,:count,2,FALSE,CAST(:checkpoint AS jsonb))"""),
            {
                "job": job,
                "client": request_id,
                "digest": bulk.cipher.digest("test-request", [job]),
                "status": status,
                "count": len(files),
                "checkpoint": bulk._seal(
                    checkpoint, user_id="owner", resource_id=job, purpose="owner-search-checkpoint"
                ),
            },
        )
        for position, extra in enumerate(files, 1):
            file_id = f"d3-file-{position}"
            metadata = {
                "id": file_id,
                "mimeType": DOC,
                "modifiedTime": "2026-09-27T00:00:00Z",
                "openUrl": f"https://drive.google.com/open?id={file_id}",
                "shareable": True,
                **extra,
            }
            connection.execute(
                text("""INSERT INTO drive_owner_search_results(
                  job_id,user_id,position,file_digest,metadata_envelope)
                  VALUES(:job,'owner',:position,:digest,CAST(:envelope AS jsonb))"""),
                {
                    "job": job,
                    "position": position,
                    "digest": bulk.cipher.digest("owner-search-file", [job, file_id]),
                    "envelope": bulk._seal(
                        metadata,
                        user_id="owner",
                        resource_id=f"{job}:{position}",
                        purpose="owner-search-result",
                    ),
                },
            )
    return job


@pytest.fixture
def autoshare(request_bulk, sharing, monkeypatch):
    """A current Trusted autoshare request whose search holds the given files."""

    async def recipient_identity(user_id):
        assert user_id == "recipient"
        return VerifiedGoogleRecipient(
            "recipient", "1234567", "b@example.invalid", datetime.now(UTC)
        )

    monkeypatch.setattr(bulk_service_module, "recipient_identity_for_user", recipient_identity)
    # The automatic slice reads search state from this isolated database.
    monkeypatch.setattr(
        bulk_service_module,
        "DriveOwnerSearchService",
        lambda: DriveOwnerSearchService(
            store=DriveOwnerSearchStore(db=sharing.db), transport=SimpleNamespace()
        ),
    )

    async def make(files, *, status="completed", patch=None):
        _membership(sharing, "active")
        await DriveLivePreferences(db=sharing.db).set_background(
            user_id="owner", enabled=True, confirmed=True
        )
        request_id = (await _request(sharing))["requestId"]
        context = await sharing.request_bulk_context(
            user_id="owner", request_id=request_id, start=True
        )
        assert context["searchStarted"] is True
        job = _seed_search(
            request_bulk, request_id=request_id, files=files, status=status, patch=patch
        )
        return request_id, job

    return make


def _store(sharing, bulk):
    return DrivePossibleMatchesStore(db=sharing.db, cipher=bulk.cipher)


def _auto(sharing, bulk):
    return DriveTrustedAutoService(sharing=sharing, bulk=bulk, wake=AsyncMock())


def _pay(db, request_id):
    with db.engine.begin() as connection:
        updated = connection.execute(
            text("""UPDATE drive_request_payment_orders SET status='paid',paid_at=clock_timestamp()
            WHERE request_id=:request"""),
            {"request": request_id},
        ).rowcount
        if not updated:
            connection.execute(
                text("""INSERT INTO drive_request_payment_orders
                  (stripe_mode,request_id,user_id,requester_user_id,status,paid_at)
                  VALUES ('test',:request,'owner','recipient','paid',clock_timestamp())"""),
                {"request": request_id},
            )


def _claims(db, request_id):
    """Source positions frozen into batches, and those with a queued grant."""
    with db.engine.connect() as connection:
        frozen = sorted(
            connection.execute(
                text("""SELECT source_position FROM drive_bulk_share_files
                WHERE origin_request_id=:request"""),
                {"request": request_id},
            ).scalars()
        )
        granted = sorted(
            connection.execute(
                text("""SELECT f.source_position FROM drive_bulk_share_effects e
                JOIN drive_bulk_share_files f ON f.share_id=e.share_id AND f.position=e.position
                WHERE f.origin_request_id=:request AND e.recipient_user_id='recipient'"""),
                {"request": request_id},
            ).scalars()
        )
    return frozen, granted


def _envelope(db, job, position):
    with db.engine.connect() as connection:
        return connection.execute(
            text("""SELECT metadata_envelope FROM drive_owner_search_results
            WHERE job_id=:job AND position=:position"""),
            {"job": job, "position": position},
        ).scalar_one()


def _request_status(db, request_id):
    with db.engine.connect() as connection:
        return connection.execute(
            text("SELECT status FROM drive_share_requests WHERE request_id=:request"),
            {"request": request_id},
        ).scalar_one()


async def _settle_request(bulk, request_id):
    """Every queued grant of the request succeeds; finalize each batch."""
    with bulk.db.engine.connect() as connection:
        shares = connection.execute(
            text("""SELECT share_id,file_count FROM drive_bulk_shares
            WHERE origin_request_id=:request AND approved_at IS NOT NULL"""),
            {"request": request_id},
        ).all()
    for share, count in shares:
        _settle(bulk, str(share), list(range(1, count + 1)))


@pytest.mark.asyncio
async def test_possible_matches_are_never_auto_claimed_or_frozen(request_bulk, sharing, autoshare):
    request_id, job = await autoshare(
        [TITLE_1, TITLE_2, CONTENT_HIT, SYNONYM_HIT, UNTAGGED_HIT, WALK_HIT, BLOCKED_HIT]
    )
    # Only title evidence of the typed words is claimable automatically.
    assert await request_bulk.unclaimed_positions(user_id="owner", request_id=request_id) == [1, 2]
    recipient = [_recipient("recipient", "b@example.invalid")]
    for positions in ([3], [1, 4], [5], [6]):
        with pytest.raises(DriveSharingError, match="possible_match_not_sent"):
            await request_bulk.create_review(
                user_id="owner",
                search_job_id=job,
                client_request_id=str(uuid4()),
                recipients=recipient,
                excluded=[],
                origin_request_id=request_id,
                selected_positions=positions,
            )
    # Negative control: the title matches themselves still freeze.
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=job,
        client_request_id=str(uuid4()),
        recipients=recipient,
        excluded=[],
        origin_request_id=request_id,
        selected_positions=[1, 2],
    )
    assert review["shareId"]
    assert _claims(sharing.db, request_id) == ([1, 2], [])

    # A full automatic slice, paid, shares exactly the two title matches.
    _pay(sharing.db, request_id)
    assert (
        await _auto(sharing, request_bulk).share_available(user_id="owner", request_id=request_id)
        == 1
    )
    assert _claims(sharing.db, request_id) == ([1, 2], [1, 2])
    assert await request_bulk.unclaimed_positions(user_id="owner", request_id=request_id) == []


@pytest.mark.asyncio
async def test_only_the_owner_lists_or_sends_and_the_requester_sees_nothing(
    request_bulk, sharing, autoshare
):
    request_id, job = await autoshare(
        [TITLE_1, CONTENT_HIT, SYNONYM_HIT, UNTAGGED_HIT, WALK_HIT, BLOCKED_HIT]
    )
    store = _store(sharing, request_bulk)
    listed = await store.possible_matches(user_id="owner", request_id=request_id)
    assert listed["requestId"] == request_id
    assert listed["canSend"] is True
    assert listed["count"] == 4
    assert [(item["matchRef"], item["kind"], item["status"]) for item in listed["matches"]] == [
        (f"{job}:2", CONTENT, "possible"),
        (f"{job}:3", SYNONYM, "possible"),
        (f"{job}:4", CONTENT, "possible"),  # untagged: shown as found by content
        (f"{job}:5", WALK, "possible"),
    ]
    assert listed["matches"][0]["name"] == "Weekly sync agenda.pdf"
    # The title match (shares itself) and the unshareable file are never listed.
    assert f"{job}:1" not in {item["matchRef"] for item in listed["matches"]}
    assert f"{job}:6" not in {item["matchRef"] for item in listed["matches"]}

    ref = f"{job}:2"
    for intruder in ("recipient", "trusted-member", "stranger"):
        with pytest.raises(DriveSharingError, match="request_unavailable"):
            await store.possible_matches(user_id=intruder, request_id=request_id)
        with pytest.raises(DriveSharingError, match="request_unavailable"):
            await store.send(user_id=intruder, request_id=request_id, match_refs=[ref])
    assert OWNER_SENT_FIELD not in request_bulk._open(
        _envelope(sharing.db, job, 2),
        user_id="owner",
        resource_id=f"{job}:2",
        purpose="owner-search-result",
    )

    # After the title match is paid and shared, the requester's own status
    # and file list carry no trace of the possible matches.
    _pay(sharing.db, request_id)
    assert (
        await _auto(sharing, request_bulk).share_available(user_id="owner", request_id=request_id)
        == 1
    )
    await _settle_request(request_bulk, request_id)
    status = await sharing.request_status(user_id="recipient", request_id=request_id)
    files = await request_bulk.recipient_request_files(
        recipient_user_id="recipient",
        recipient_subject="1234567",
        recipient_email="b@example.invalid",
        request_id=request_id,
    )
    assert status["status"] == "completed"
    assert files["sharedCount"] == 1
    assert [item["openUrl"] for item in files["files"]] == [
        "https://drive.google.com/file/d/d3-file-1/view"
    ]
    serialized = json.dumps([status, files], default=str).casefold()
    for secret in ("possible", "weekly sync", "recap", "roadmap", "team folder", job):
        assert secret not in serialized
    # The owner still sees them, unchanged by the finished delivery.
    assert (await store.possible_matches(user_id="owner", request_id=request_id))["count"] == 4


@pytest.mark.asyncio
async def test_send_is_idempotent_and_releases_only_the_chosen_files(
    request_bulk, sharing, autoshare
):
    request_id, job = await autoshare([TITLE_1, CONTENT_HIT, SYNONYM_HIT, BLOCKED_HIT])
    store = _store(sharing, request_bulk)
    before = _envelope(sharing.db, job, 2)

    sent = await store.send(user_id="owner", request_id=request_id, match_refs=[f"{job}:2"])
    assert sent == {
        "requestId": request_id,
        "queued": 1,
        "matches": [{"matchRef": f"{job}:2", "status": "queued"}],
    }
    marked = _envelope(sharing.db, job, 2)
    assert marked != before
    # The marker lives only inside the AES-GCM envelope.
    assert "possibleMatchSent" not in json.dumps(marked)
    again = await store.send(user_id="owner", request_id=request_id, match_refs=[f"{job}:2"])
    assert again["queued"] == 0
    assert again["matches"] == [{"matchRef": f"{job}:2", "status": "queued"}]
    assert _envelope(sharing.db, job, 2) == marked

    assert await request_bulk.unclaimed_positions(user_id="owner", request_id=request_id) == [1, 2]
    listed = await store.possible_matches(user_id="owner", request_id=request_id)
    assert [(item["matchRef"], item["status"]) for item in listed["matches"]] == [
        (f"{job}:2", "queued"),
        (f"{job}:3", "possible"),
    ]

    # Only possible matches can be sent, from this search, at real positions.
    for refs, code in (
        ([f"{job}:1"], "invalid_argument"),  # a title match shares itself
        ([f"{job}:4"], "invalid_argument"),  # unshareable
        ([f"{job}:9"], "invalid_argument"),  # no such result
        ([f"{uuid4()}:2"], "request_changed"),  # an earlier search's ref
        ([f"{job}:2", f"{job}:2"], "invalid_argument"),
        ([], "invalid_argument"),
        (["../2"], "invalid_argument"),
    ):
        with pytest.raises(DriveSharingError, match=code):
            await store.send(user_id="owner", request_id=request_id, match_refs=refs)
    # A refused mixed batch marks nothing: position 3 is still unsent.
    with pytest.raises(DriveSharingError, match="invalid_argument"):
        await store.send(
            user_id="owner", request_id=request_id, match_refs=[f"{job}:3", f"{job}:1"]
        )
    assert await request_bulk.unclaimed_positions(user_id="owner", request_id=request_id) == [1, 2]


@pytest.mark.asyncio
async def test_send_before_payment_waits_for_payment_then_joins_the_next_batch(
    request_bulk, sharing, autoshare
):
    request_id, job = await autoshare([TITLE_1, TITLE_2, CONTENT_HIT])
    auto = _auto(sharing, request_bulk)
    # B has not paid: the first batch freezes and waits; nothing is granted.
    assert await auto.share_available(user_id="owner", request_id=request_id) == 0
    assert _claims(sharing.db, request_id) == ([1, 2], [])
    store = _store(sharing, request_bulk)
    await store.send(user_id="owner", request_id=request_id, match_refs=[f"{job}:3"])

    # Still unpaid: the sent file neither freezes nor grants, and does not
    # block the requester's Checkout of the already frozen batch.
    assert await auto.share_available(user_id="owner", request_id=request_id) == 0
    assert _claims(sharing.db, request_id) == ([1, 2], [])
    checkout = await request_bulk.legacy_checkout_sources(user_id="owner", request_id=request_id)
    assert [item["id"] for item in checkout] == ["d3-file-1", "d3-file-2"]
    listed = await store.possible_matches(user_id="owner", request_id=request_id)
    assert [(item["matchRef"], item["status"]) for item in listed["matches"]] == [
        (f"{job}:3", "queued")
    ]

    # After payment the frozen batch is approved, then the sent file follows
    # in the next batch of the same slice.
    _pay(sharing.db, request_id)
    assert await auto.share_available(user_id="owner", request_id=request_id) == 2
    assert _claims(sharing.db, request_id) == ([1, 2, 3], [1, 2, 3])
    with sharing.db.engine.connect() as connection:
        batches = connection.execute(
            text("""SELECT file_count,approval_source FROM drive_bulk_shares
            WHERE origin_request_id=:request ORDER BY created_at"""),
            {"request": request_id},
        ).all()
    assert [tuple(row) for row in batches] == [(2, "trusted_auto"), (1, "trusted_auto")]
    # Claimed: it leaves the possible list (shared files show it once confirmed).
    assert (await store.possible_matches(user_id="owner", request_id=request_id))["count"] == 0


@pytest.mark.asyncio
async def test_unpaid_checkout_still_waits_for_every_title_match(request_bulk, sharing, autoshare):
    # Contrast for the test above: an unfrozen title match does block Checkout.
    request_id, _ = await autoshare([TITLE_1, TITLE_2, CONTENT_HIT])
    recipient = [_recipient("recipient", "b@example.invalid")]
    with sharing.db.engine.connect() as connection:
        job = connection.execute(
            text("SELECT job_id FROM drive_owner_search_jobs WHERE client_request_id=:request"),
            {"request": request_id},
        ).scalar_one()
    await request_bulk.create_review(
        user_id="owner",
        search_job_id=str(job),
        client_request_id=str(uuid4()),
        recipients=recipient,
        excluded=[],
        origin_request_id=request_id,
        selected_positions=[1],
    )
    with pytest.raises(DriveSharingError, match="payment_not_ready"):
        await request_bulk.legacy_checkout_sources(user_id="owner", request_id=request_id)


@pytest.mark.asyncio
async def test_send_after_payment_joins_the_next_batch_and_is_due_without_a_wake(
    request_bulk, sharing, autoshare
):
    request_id, job = await autoshare([TITLE_1, CONTENT_HIT, SYNONYM_HIT], status="running")
    _pay(sharing.db, request_id)
    auto = _auto(sharing, request_bulk)
    assert await auto.share_available(user_id="owner", request_id=request_id) == 1
    assert _claims(sharing.db, request_id) == ([1], [1])
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests
            SET preparation_next_at=clock_timestamp()+INTERVAL '1 hour' WHERE request_id=:request"""),
            {"request": request_id},
        )
    assert request_id not in {item["request_id"] for item in await sharing.due_trusted_batches()}

    auto.wake.reset_mock()
    await _store(sharing, request_bulk).send(
        user_id="owner", request_id=request_id, match_refs=[f"{job}:3"]
    )
    # Due for the next scheduled drain; Send itself made no wake call.
    auto.wake.assert_not_awaited()
    assert request_id in {item["request_id"] for item in await sharing.due_trusted_batches()}
    assert await auto.share_available(user_id="owner", request_id=request_id) == 1
    assert _claims(sharing.db, request_id) == ([1, 3], [1, 3])
    # The unsent synonym hit is still waiting, never claimed.
    assert await request_bulk.unclaimed_positions(user_id="owner", request_id=request_id) == []


@pytest.mark.asyncio
async def test_only_possible_matches_finish_as_no_match_with_no_payment(
    request_bulk, sharing, autoshare
):
    request_id, _ = await autoshare([CONTENT_HIT, SYNONYM_HIT, BLOCKED_HIT])
    assert (
        await _auto(sharing, request_bulk).share_available(user_id="owner", request_id=request_id)
        == 0
    )
    # Exactly what the requester sees when nothing matched: no order, no
    # batch, and a no_match outcome. The list never holds the request open.
    assert _request_status(sharing.db, request_id) == "no_match"
    assert _claims(sharing.db, request_id) == ([], [])
    with sharing.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders WHERE request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            == 0
        )
    listed = await _store(sharing, request_bulk).possible_matches(
        user_id="owner", request_id=request_id
    )
    assert (listed["count"], listed["canSend"]) == (2, False)
    with pytest.raises(DriveSharingError, match="request_changed"):
        await _store(sharing, request_bulk).send(
            user_id="owner", request_id=request_id, match_refs=[listed["matches"][0]["matchRef"]]
        )


@pytest.mark.asyncio
async def test_unsent_possible_match_never_holds_the_request_but_a_sent_one_does(
    request_bulk, sharing, autoshare
):
    unsent_request, _ = await autoshare([TITLE_1, CONTENT_HIT])
    _pay(sharing.db, unsent_request)
    auto = _auto(sharing, request_bulk)
    assert await auto.share_available(user_id="owner", request_id=unsent_request) == 1
    await _settle_request(request_bulk, unsent_request)
    assert _request_status(sharing.db, unsent_request) == "completed"

    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_owner_search_jobs SET status='stopped' WHERE user_id='owner'")
        )
    held_request, job = await autoshare([TITLE_1, CONTENT_HIT])
    _pay(sharing.db, held_request)
    assert await auto.share_available(user_id="owner", request_id=held_request) == 1
    await _store(sharing, request_bulk).send(
        user_id="owner", request_id=held_request, match_refs=[f"{job}:2"]
    )
    await _settle_request(request_bulk, held_request)
    # The owner's sent file is real remaining work: the request stays open.
    assert _request_status(sharing.db, held_request) == "pending"
    assert await auto.share_available(user_id="owner", request_id=held_request) == 1
    await _settle_request(request_bulk, held_request)
    assert _request_status(sharing.db, held_request) == "completed"
    assert _claims(sharing.db, held_request) == ([1, 2], [1, 2])


@pytest.mark.asyncio
async def test_finished_request_lists_read_only_and_refuses_send(request_bulk, sharing, autoshare):
    request_id, job = await autoshare([TITLE_1, CONTENT_HIT])
    _pay(sharing.db, request_id)
    assert (
        await _auto(sharing, request_bulk).share_available(user_id="owner", request_id=request_id)
        == 1
    )
    await _settle_request(request_bulk, request_id)
    assert _request_status(sharing.db, request_id) == "completed"
    store = _store(sharing, request_bulk)
    listed = await store.possible_matches(user_id="owner", request_id=request_id)
    assert (listed["count"], listed["canSend"]) == (1, False)
    with pytest.raises(DriveSharingError, match="request_changed"):
        await store.send(user_id="owner", request_id=request_id, match_refs=[f"{job}:2"])
    assert OWNER_SENT_FIELD not in request_bulk._open(
        _envelope(sharing.db, job, 2),
        user_id="owner",
        resource_id=f"{job}:2",
        purpose="owner-search-result",
    )


@pytest.mark.asyncio
async def test_bounded_search_lists_nothing_until_its_final_ranking(
    request_bulk, sharing, autoshare
):
    request_id, job = await autoshare(
        [TITLE_1, CONTENT_HIT], status="running", patch={"request_result_limit": 5}
    )
    store = _store(sharing, request_bulk)
    assert (await store.possible_matches(user_id="owner", request_id=request_id))["matches"] == []
    with pytest.raises(DriveSharingError, match="search_in_progress"):
        await store.send(user_id="owner", request_id=request_id, match_refs=[f"{job}:2"])


@pytest.mark.asyncio
async def test_owner_reviewed_search_is_never_reclassified(request_bulk, sharing, autoshare):
    # Owner review already decides every exact file: no possible list, and a
    # content-tagged file stays in the owner's ordinary review.
    request_id, job = await autoshare(
        [TITLE_1, CONTENT_HIT],
        patch={"request_owner_review_required": True, "request_selection_policy": None},
    )
    store = _store(sharing, request_bulk)
    assert (await store.possible_matches(user_id="owner", request_id=request_id))["count"] == 0
    with pytest.raises(DriveSharingError, match="request_changed"):
        await store.send(user_id="owner", request_id=request_id, match_refs=[f"{job}:2"])
