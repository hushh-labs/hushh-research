"""A document request freezes every Drive match for only its verified recipient."""

# ruff: noqa: F811 -- imported isolated PostgreSQL fixtures

import asyncio
import base64
import json
import threading
import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.runtime_settings import clear_runtime_settings_caches
from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_bulk_share_worker import DriveBulkShareWorker
from hushh_mcp.services.drive_owner_search_service import (
    DriveOwnerSearchService,
    compile_request_queries,
)
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_package_access_preflight import DrivePackageAccessPreflight
from hushh_mcp.services.drive_request_bulk_service import (
    DriveRequestBulkService,
    _deterministic_statement_plan,
)
from hushh_mcp.services.drive_request_owner_payout_service import DriveRequestOwnerPayoutService
from hushh_mcp.services.drive_request_payment_refunds import _claim_refunds
from hushh_mcp.services.drive_request_payment_service import DriveRequestPaymentService
from hushh_mcp.services.drive_request_recovery_view import (
    owner_review_request_view,
    requester_recovery_view,
)
from hushh_mcp.services.drive_sharing_contract import (
    DriveSharingError,
    ShareRequestPurpose,
    VerifiedGoogleRecipient,
)
from hushh_mcp.services.drive_sharing_retention import erase_drive_account_in_transaction
from hushh_mcp.services.drive_sharing_service import DriveSharingService
from hushh_mcp.services.drive_suggestion_store import DriveSuggestionStore
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from hushh_mcp.services.google_drive_adapter import (
    DRIVE_BASE,
    DRIVE_POLICY,
    LIVE_POLICY_HASH,
    DriveReadError,
)
from hushh_mcp.services.google_drive_permission_adapter import (
    CreatedReader,
    PermissionSnapshot,
)
from hushh_mcp.services.pkm_payout_service import PkmPayoutService
from tests.services.test_drive_sharing_store import (  # noqa: F401
    MIGRATIONS,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    sharing,
)


@pytest.fixture
def request_bulk(sharing, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("GOOGLE_DRIVE_LIVE", "true")
    monkeypatch.setenv("DRIVE_DOCUMENT_SHARING", "true")
    monkeypatch.setenv("DRIVE_REQUEST_PAYMENTS_ENABLED", "true")
    monkeypatch.setenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", "true")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    clear_runtime_settings_caches()
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner,recipient,trusted-member")
    monkeypatch.setenv("DRIVE_SHARING_KEY_V1", base64.b64encode(b"s" * 32).decode())
    # Paid-flow tests start with the owner's explicit price and verified bank
    # setup. Missing/restricted setup has separate negative controls.
    monkeypatch.setattr(
        PkmPayoutService,
        "refresh_account",
        AsyncMock(
            return_value={
                "stripe_account_id": "acct_test_owner",
                "readiness": {"ready": True},
            }
        ),
    )
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_request_owner_pricing
          (user_id,enabled,amount_cents,version) VALUES ('owner',TRUE,1000,1)""")
        )
        connection.execute(
            text("""INSERT INTO stripe_owner_payout_accounts
          (stripe_mode,user_id,stripe_account_id,details_submitted,payouts_enabled,account_ready)
          VALUES ('test','owner','acct_test_owner',TRUE,TRUE,TRUE)""")
        )
        connection.execute(
            text("""UPDATE external_mcp_connectors SET transport_kind='google_drive_rest',
            mcp_endpoint=:endpoint,capability_policy=CAST(:policy AS jsonb)
            WHERE connector_id='google_drive'"""),
            {"endpoint": DRIVE_BASE, "policy": json.dumps(DRIVE_POLICY)},
        )
        connection.execute(
            text("""UPDATE user_external_connector_connections SET
            validation_state='verified',verified_policy_hash=:policy
            WHERE user_id='owner' AND connector_id='google_drive'"""),
            {"policy": LIVE_POLICY_HASH},
        )
        # A real accepted connection exists for B. A separate trusted-circle
        # member must never be added to this request's recipient snapshot.
        connection.execute(
            text("""CREATE TABLE IF NOT EXISTS connection_origins(
              connection_id UUID, status TEXT, origin_kind TEXT)""")
        )
        connection.execute(
            text("""CREATE TABLE IF NOT EXISTS one_location_circles(
              id UUID, owner_user_id TEXT, system_kind TEXT, status TEXT)""")
        )
        connection.execute(
            text("""CREATE TABLE IF NOT EXISTS one_location_circle_memberships(
              circle_id UUID, user_id TEXT, status TEXT)""")
        )
        connection.execute(
            text("""INSERT INTO connection_origins(connection_id,status,origin_kind)
            SELECT c.id,'active','direct_request' FROM connections c
            WHERE NOT EXISTS(SELECT 1 FROM connection_origins o
              WHERE o.connection_id=c.id AND o.status='active'
                AND o.origin_kind='direct_request')""")
        )
        trusted_connection = str(uuid4())
        circle = str(uuid4())
        connection.execute(
            text("INSERT INTO connections VALUES (:id,'owner','trusted-member','active')"),
            {"id": trusted_connection},
        )
        connection.execute(
            text("""INSERT INTO connection_origins VALUES
            (:id,'active','direct_request')"""),
            {"id": trusted_connection},
        )
        connection.execute(
            text("""INSERT INTO one_location_circles VALUES
            (:id,'owner','trusted','active')"""),
            {"id": circle},
        )
        connection.execute(
            text("""INSERT INTO one_location_circle_memberships VALUES
            (:circle,'trusted-member','active')"""),
            {"circle": circle},
        )
    yield DriveBulkShareStore(db=sharing.db)
    clear_runtime_settings_caches()


async def _request(sharing, *, purpose_text="Standup notes from last 3 months"):
    today = datetime.now(UTC).date()
    return await sharing.create_request(
        recipient=VerifiedGoogleRecipient(
            "recipient", "1234567", "b@example.invalid", datetime.now(UTC)
        ),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        expected_quote_version=1,
        purpose=ShareRequestPurpose(
            purpose=purpose_text,
            periodStart=(today - timedelta(days=90)).isoformat(),
            periodEnd=today.isoformat(),
        ),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("authority", ["nontrusted", "owner_allowed", "trusted"])
@pytest.mark.parametrize("selection_intent", ["document_coverage", "legacy"])
async def test_unverified_candidates_payment_starts_only_after_exact_owner_approval(
    request_bulk, sharing, authority, selection_intent, monkeypatch
):
    if authority == "trusted":
        with sharing.db.engine.begin() as connection:
            connection.execute(
                text("""INSERT INTO one_location_circle_memberships
                SELECT id,'recipient','active' FROM one_location_circles
                WHERE owner_user_id='owner' AND system_kind='trusted'""")
            )
    created = await _request(sharing)
    request_id = created["requestId"]
    if authority == "owner_allowed":
        await sharing.allow_request(
            user_id="owner", request_id=request_id, revision=created["revision"], amount_cents=1000
        )
    selection = (
        {
            "request_selection_version": 2,
            "request_time_intent": "document_coverage",
            "request_owner_review_required": True,
        }
        if selection_intent == "document_coverage"
        else None
    )
    search = _search(request_bulk, request_id=request_id, count=1, selection=selection)
    assert (await sharing.owner_review(user_id="owner", request_id=request_id))[
        "trustedAuto"
    ] is False
    assert (
        await DriveOwnerSearchStore(db=sharing.db).by_client(
            user_id="owner", client_request_id=request_id
        )
    )["coverage"]["ownerReviewRequired"] is True
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request_id,
        selected_positions=[1],
    )
    create_session = Mock(
        side_effect=lambda **params: {
            "id": "cs_test_owner_approved",
            "mode": "payment",
            "client_reference_id": params["client_reference_id"],
            "amount_total": 1000,
            "currency": "usd",
            "livemode": False,
            "metadata": params["metadata"],
            "url": "https://checkout.stripe.com/c/pay/cs_test_owner_approved",
            "expires_at": params["expires_at"],
        }
    )
    payment = DriveRequestPaymentService(
        db=sharing.db,
        stripe_api=SimpleNamespace(
            checkout=SimpleNamespace(Session=SimpleNamespace(create=create_session))
        ),
    )
    # An autoshare request the owner allowed is priced by that sealed Allow, so
    # its order exists at the owner's price while the search still runs. Nothing
    # else moves early: Checkout, the automatic approval and delivery all still
    # wait for the owner's exact approval of these unverified candidates.
    pay_on_allow = authority == "owner_allowed"
    orders_before_approval = 1 if pay_on_allow else 0
    assert (await payment.payment_state(requester_user_id="recipient", request_id=request_id))[
        "status"
    ] == ("awaiting_payment" if pay_on_allow else "preparing")
    with pytest.raises(DriveSharingError, match="payment_not_ready"):
        await payment.ensure_payment_for_frozen_batch("owner", request_id, review["shareId"])
    with pytest.raises(DriveSharingError, match="payment_not_ready"):
        await payment.checkout(requester_user_id="recipient", request_id=request_id)
    with pytest.raises(DriveSharingError, match="trusted_request_unavailable"):
        await request_bulk.approve(
            user_id="owner",
            share_id=review["shareId"],
            revision=review["revision"],
            review_digest=review["reviewDigest"],
            approval_source="trusted_auto",
        )
    create_session.assert_not_called()
    with sharing.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders WHERE request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            == orders_before_approval
        )
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_share_events
              WHERE request_id=:request AND event_type='document_share_payment_ready'"""),
                {"request": request_id},
            ).scalar_one()
            == 0
        )

    await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    state = await payment.payment_state(requester_user_id="recipient", request_id=request_id)
    assert state["status"] == "awaiting_payment"
    assert request_id in {row["request_id"] for row in await payment.due_checkout_orders(limit=20)}
    # An unpaid grant is not work: the queue leaves it out, and a direct claim
    # defers it without any durable change, so it can never loop in a worker.
    assert review["shareId"] not in {str(row["share_id"]) for row in await request_bulk.due()}
    assert (
        await request_bulk.claim(
            user_id="owner",
            share_id=review["shareId"],
            position=1,
            recipient_user_id="recipient",
        )
        is None
    )
    with sharing.db.engine.begin() as connection:
        assert tuple(
            connection.execute(
                text("""SELECT state,attempts,lease_id FROM drive_bulk_share_effects
                WHERE share_id=:share"""),
                {"share": review["shareId"]},
            ).one()
        ) == ("queued", 0, None)

    async def absent_buyer_acl(self, *, user_id, request_id, require_current, files=None):
        # Only replace the unavailable live Drive ACL read. Exact approved
        # source selection and current request authority still run in SQL.
        assert files and len({file["id"] for file in files}) == len(files)
        assert all(file["name"] and file["modifiedTime"] and file["generation"] for file in files)
        await require_current()
        context = await self.sharing.request_bulk_context(user_id=user_id, request_id=request_id)
        await require_current()
        return SimpleNamespace(status="none", request_revision=context["revision"])

    monkeypatch.setattr(DrivePackageAccessPreflight, "inspect", absent_buyer_acl)
    assert (await payment.checkout(requester_user_id="recipient", request_id=request_id))[
        "checkoutUrl"
    ] == "https://checkout.stripe.com/c/pay/cs_test_owner_approved"
    create_session.assert_called_once()
    with sharing.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT status FROM drive_share_requests WHERE request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            == "pending"
        )
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders WHERE request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            == 1
        )
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_share_events
              WHERE request_id=:request AND event_type='document_share_payment_ready'"""),
                {"request": request_id},
            ).scalar_one()
            == 1
        )

    # Payment can enable only this exact, explicitly approved owner batch.
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_request_payment_orders
            SET status='paid',paid_at=clock_timestamp() WHERE request_id=:request"""),
            {"request": request_id},
        )
        assert (
            connection.execute(
                text("SELECT approval_source FROM drive_bulk_shares WHERE share_id=:share"),
                {"share": review["shareId"]},
            ).scalar_one()
            == "owner"
        )
    assert review["shareId"] in {str(row["share_id"]) for row in await request_bulk.due()}
    claim = await request_bulk.claim(
        user_id="owner", share_id=review["shareId"], position=1, recipient_user_id="recipient"
    )
    assert claim is not None
    await request_bulk.require_current(claim)


@pytest.mark.asyncio
async def test_v1_owner_selected_statement_is_checkout_source_with_unrelated_drive_candidate(
    request_bulk, sharing
):
    created = await _request(sharing, purpose_text="Schwab brokerage statements from 2026")
    request_id = created["requestId"]
    search = _search(
        request_bulk,
        request_id=request_id,
        count=2,
        names={1: "Schwab brokerage statement September 2026", 2: "Unrelated standup notes"},
        selection={
            "request_selection_version": 2,
            "request_time_intent": "document_coverage",
            "request_owner_review_required": True,
        },
    )
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_owner_search_jobs SET v1_statement_search=TRUE WHERE job_id=:job"),
            {"job": search},
        )
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request_id,
        selected_positions=[1],
    )
    await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )

    sources = await request_bulk.legacy_manual_checkout_sources(
        user_id="owner", request_id=request_id
    )
    assert [item["id"] for item in sources] == ["standup-file-1"]
    assert [item["name"] for item in sources] == ["Schwab brokerage statement September 2026"]

    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_owner_search_jobs SET incomplete_search=TRUE WHERE job_id=:job"),
            {"job": search},
        )
    with pytest.raises(DriveSharingError, match="payment_not_ready"):
        await request_bulk.legacy_manual_checkout_sources(user_id="owner", request_id=request_id)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_owner_search_jobs SET incomplete_search=FALSE WHERE job_id=:job"),
            {"job": search},
        )
        connection.execute(
            text(
                "UPDATE drive_bulk_shares SET approval_source='trusted_auto' WHERE share_id=:share"
            ),
            {"share": review["shareId"]},
        )
    with pytest.raises(DriveSharingError, match="payment_not_ready"):
        await request_bulk.legacy_manual_checkout_sources(user_id="owner", request_id=request_id)


FILE_ACTIVITY_SELECTION = {
    "request_selection_version": 2,
    "request_time_intent": "file_activity",
    "request_owner_review_required": False,
}


def _search(
    bulk,
    *,
    request_id,
    count=525,
    incomplete=False,
    shareability=None,
    names=None,
    verified=True,
    selection=None,
):
    job = str(uuid4())
    rows = []
    for position in range(1, count + 1):
        file_id = f"standup-file-{position}"
        metadata = {
            "id": file_id,
            "name": (names or {}).get(
                position, f"Standup notes 2026-09-{(position % 28) + 1:02d} #{position}"
            ),
            "mimeType": "application/vnd.google-apps.document",
            "modifiedTime": "2026-09-27T00:00:00Z",
            "openUrl": f"https://drive.google.com/open?id={file_id}",
            "shareable": True,
        }
        if shareability and position in shareability:
            if shareability[position] is None:
                metadata.pop("shareable")
            else:
                metadata["shareable"] = shareability[position]
        rows.append(
            {
                "job": job,
                "user": "owner",
                "position": position,
                "digest": bulk.cipher.digest("owner-search-file", [job, file_id]),
                "envelope": bulk._seal(
                    metadata,
                    user_id="owner",
                    resource_id=f"{job}:{position}",
                    purpose="owner-search-result",
                ),
            }
        )
    with bulk.db.engine.begin() as connection:
        request_revision = connection.execute(
            text("""UPDATE drive_share_requests SET bulk_search_started_at=clock_timestamp()
            WHERE request_id=:request RETURNING revision"""),
            {"request": request_id},
        ).scalar_one()
        connection.execute(
            text("""INSERT INTO drive_owner_search_jobs(
              job_id,user_id,client_request_id,request_digest,connection_generation,
              consent_version,status,revision,matched,pages_scanned,incomplete_search,
              checkpoint_envelope)
              VALUES(:job,'owner',:client,:digest,1,'drive-owner-search-v1',
                :status,24,:count,23,:incomplete,CAST(:checkpoint AS jsonb))"""),
            {
                "job": job,
                "client": request_id,
                "digest": bulk.cipher.digest("test-request", [job]),
                "status": "limited" if incomplete else "completed",
                "count": count,
                "incomplete": incomplete,
                "checkpoint": bulk._seal(
                    {
                        "done": not incomplete,
                        "request_origin_id": request_id,
                        "request_revision": request_revision,
                        **({"request_shareability_version": 1} if verified else {}),
                        **(selection or {}),
                    },
                    user_id="owner",
                    resource_id=job,
                    purpose="owner-search-checkpoint",
                ),
            },
        )
        if rows:
            connection.execute(
                text("""INSERT INTO drive_owner_search_results(
                  job_id,user_id,position,file_digest,metadata_envelope)
                  VALUES(:job,:user,:position,:digest,CAST(:envelope AS jsonb))"""),
                rows,
            )
    return job


@pytest.mark.parametrize("status", ["queued", "running", "completed"])
@pytest.mark.parametrize("progressive", [False, True])
async def test_bounded_candidates_cannot_be_frozen_or_paid_before_final_ranking(
    request_bulk, sharing, status, progressive
):
    request_id = (await _request(sharing))["requestId"]
    search = _search(
        request_bulk,
        request_id=request_id,
        count=1,
        selection={"request_result_limit": 100, "request_order_field": "modifiedTime"},
    )
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_owner_search_jobs SET status=:status WHERE job_id=:job"),
            {"job": search, "status": status},
        )
    assert await request_bulk.unclaimed_positions(user_id="owner", request_id=request_id) == []
    with pytest.raises(DriveSharingError, match="search_in_progress"):
        await request_bulk.create_review(
            user_id="owner",
            search_job_id=search,
            client_request_id=str(uuid4()),
            recipients=[_recipient("recipient", "b@example.invalid")],
            excluded=[],
            origin_request_id=request_id,
            **({"selected_positions": [1]} if progressive else {}),
        )
    with sharing.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders WHERE request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_bulk_shares WHERE origin_request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            == 0
        )


async def test_bounded_final_selection_can_enter_normal_review(request_bulk, sharing):
    request_id = (await _request(sharing))["requestId"]
    search = _search(
        request_bulk,
        request_id=request_id,
        count=1,
        selection={
            "request_result_limit": 100,
            "request_order_field": "modifiedTime",
            "request_results_finalized": True,
        },
    )
    assert await request_bulk.unclaimed_positions(user_id="owner", request_id=request_id) == [1]
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request_id,
        selected_positions=[1],
    )
    assert review["status"] == "review_ready"


@pytest.mark.asyncio
async def test_completed_search_without_matches_has_no_permission_attempt(request_bulk, sharing):
    request = await _request(sharing)
    _search(request_bulk, request_id=request["requestId"], count=0)

    await request_bulk.refresh_request(user_id="owner", request_id=request["requestId"])

    owner = await sharing.request_status(user_id="owner", request_id=request["requestId"])
    recipient = await sharing.request_status(user_id="recipient", request_id=request["requestId"])
    assert owner["status"] == "no_match"
    assert recipient["status"] == "no_files_shared"
    delivery = DriveSharingService(
        oauth=SimpleNamespace(lifecycle=SimpleNamespace(db=sharing.db)),
        store=DriveSuggestionStore(db=sharing.db),
        verify_recipient=AsyncMock(),
    )
    result = await delivery.delivery(user_id="recipient", request_id=request["requestId"])
    assert result["status"] == "no_files_shared"
    assert result["files"] == []
    assert "bulkShareId" not in result
    with request_bulk.db.engine.begin() as connection:
        for query in (
            "SELECT count(*) FROM drive_bulk_shares WHERE origin_request_id=:request",
            "SELECT count(*) FROM drive_share_permission_operations WHERE request_id=:request",
        ):
            assert (
                connection.execute(text(query), {"request": request["requestId"]}).scalar_one() == 0
            )
        events = (
            connection.execute(
                text("""SELECT user_id FROM drive_share_events
            WHERE request_id=:request AND event_type='document_share_outcome'"""),
                {"request": request["requestId"]},
            )
            .scalars()
            .all()
        )
    assert set(events) == {"owner", "recipient"}


@pytest.mark.parametrize(
    "fault", ["request_origin_id", "request_revision", "request_shareability_version", "stop"]
)
def test_terminal_outcome_fence_rejects_unbound_or_stopped_evidence_without_database(fault):
    request_id, job_id = str(uuid4()), str(uuid4())
    request = {
        "user_id": "owner",
        "request_id": request_id,
        "status": "pending",
        "revision": 2,
        "access_stop_requested_at": datetime.now(UTC) if fault == "stop" else None,
    }
    checkpoint = {
        "request_origin_id": request_id,
        "request_revision": 2,
        "request_shareability_version": 1,
    }
    source = {
        "job_id": job_id,
        "status": "completed",
        "incomplete_search": False,
        "checkpoint_envelope": {},
    }
    if fault != "stop":
        checkpoint[fault] = None
    bulk = DriveBulkShareStore(
        db=SimpleNamespace(), cipher=SimpleNamespace(open=Mock(return_value=checkpoint))
    )
    bulk._row = Mock(side_effect=[request, source])
    connection = SimpleNamespace(execute=Mock(side_effect=RuntimeError("passed evidence fence")))
    bulk._finalize_progressive_request(connection, request_id)
    connection.execute.assert_not_called()

    # Positive control reaches downstream finalization with current evidence;
    # the fence must not suppress genuine empty-search outcomes unconditionally.
    request["access_stop_requested_at"] = None
    checkpoint.update(
        request_origin_id=request_id, request_revision=2, request_shareability_version=1
    )
    bulk._row.reset_mock(side_effect=True)
    bulk._row.side_effect = [request, source]
    with pytest.raises(RuntimeError, match="passed evidence fence"):
        bulk._finalize_progressive_request(connection, request_id)
    connection.execute.assert_called_once()


@pytest.mark.parametrize(
    ("partial_coverage", "delivered", "expected"),
    [(True, 0, "partial"), (False, 0, "no_match"), (True, 1, "partial"), (False, 1, "completed")],
)
def test_semantic_terminal_coverage_never_claims_exhaustive_outcome_without_database(
    partial_coverage,
    delivered,
    expected,
):
    request_id, job_id = str(uuid4()), str(uuid4())
    request = {
        "request_id": request_id,
        "user_id": "owner",
        "recipient_user_id": "recipient",
        "status": "pending",
        "revision": 2,
        "access_stop_requested_at": None,
        "payment_required": False,
    }
    checkpoint = {
        "request_origin_id": request_id,
        "request_revision": 2,
        "request_shareability_version": 1,
        "semantic_plan": {"version": 1},
        "semantic_coverage_incomplete": partial_coverage,
    }
    source = {
        "job_id": job_id,
        "status": "completed",
        "incomplete_search": False,
        "checkpoint_envelope": {},
        "matched": delivered,
    }
    states = [("succeeded", delivered)] if delivered else []
    # SQL I/O supplies completed batches and no outstanding/unclaimed files.
    # The production finalizer, rather than this fixture, decides the outcome.
    connection = SimpleNamespace(
        execute=Mock(
            return_value=SimpleNamespace(
                scalar_one=lambda: False,
                mappings=lambda: [],
                all=lambda: states,
            )
        )
    )
    bulk = DriveBulkShareStore(
        db=SimpleNamespace(),
        cipher=SimpleNamespace(open=Mock(return_value=checkpoint)),
    )
    terminal = []

    def row(connection, query, params):
        if query.startswith("SELECT * FROM drive_share_requests"):
            return request
        if query.startswith("SELECT * FROM drive_owner_search_jobs"):
            return source
        assert query.startswith("UPDATE drive_share_requests")
        terminal.append(params["status"])
        return None  # Outcome notification I/O is outside this regression.

    bulk._row = row
    bulk._finalize_progressive_request(connection, request_id)
    assert terminal == [expected]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "binding", ["request_origin_id", "request_revision", "request_shareability_version"]
)
async def test_empty_search_cannot_finalize_a_request_without_current_binding(
    request_bulk, sharing, binding
):
    request = await _request(sharing)
    request_id = request["requestId"]
    job_id = _search(request_bulk, request_id=request_id, count=0)
    with request_bulk.db.engine.begin() as connection:
        source = dict(
            connection.execute(
                text("SELECT * FROM drive_owner_search_jobs WHERE job_id=:job"),
                {"job": job_id},
            )
            .mappings()
            .one()
        )
        checkpoint = request_bulk._open(
            source["checkpoint_envelope"],
            user_id="owner",
            resource_id=job_id,
            purpose="owner-search-checkpoint",
        )
        if binding == "request_revision":
            checkpoint[binding] += 1
        else:
            checkpoint.pop(binding)
        connection.execute(
            text("""UPDATE drive_owner_search_jobs SET checkpoint_envelope=CAST(:envelope AS jsonb)
            WHERE job_id=:job"""),
            {
                "job": job_id,
                "envelope": request_bulk._seal(
                    checkpoint,
                    user_id="owner",
                    resource_id=job_id,
                    purpose="owner-search-checkpoint",
                ),
            },
        )
    await request_bulk.refresh_request(user_id="owner", request_id=request_id)
    assert (await sharing.request_status(user_id="owner", request_id=request_id))[
        "status"
    ] == "pending"
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_share_events
            WHERE request_id=:request AND event_type='document_share_outcome'"""),
                {"request": request_id},
            ).scalar_one()
            == 0
        )
        # A current, request-bound empty search still publishes its genuine
        # terminal result. The guard must not hide all no-match outcomes.
        connection.execute(
            text("""UPDATE drive_owner_search_jobs SET checkpoint_envelope=CAST(:envelope AS jsonb)
            WHERE job_id=:job"""),
            {"job": job_id, "envelope": json.dumps(source["checkpoint_envelope"])},
        )
    await request_bulk.refresh_request(user_id="owner", request_id=request_id)
    assert (await sharing.request_status(user_id="owner", request_id=request_id))[
        "status"
    ] == "no_match"


@pytest.mark.asyncio
async def test_no_match_migration_repairs_only_empty_historical_outcomes(request_bulk, sharing):
    empty = await _request(sharing)
    found = await _request(sharing)
    _search(request_bulk, request_id=empty["requestId"], count=0)
    _search(request_bulk, request_id=found["requestId"], count=1)
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests SET status='partial'
            WHERE request_id IN (:empty,:found)"""),
            {"empty": empty["requestId"], "found": found["requestId"]},
        )
        connection.execute(
            text("""CREATE TABLE IF NOT EXISTS feed_events (
            source_domain TEXT, event_type TEXT, metadata JSONB NOT NULL)""")
        )
        for request, audience in ((empty, "owner"), (empty, "recipient"), (found, "owner")):
            connection.execute(
                text("""INSERT INTO feed_events(source_domain,event_type,metadata)
                VALUES ('connected_systems','document_share_outcome',CAST(:metadata AS jsonb))"""),
                {
                    "metadata": json.dumps(
                        {
                            "request_id": request["requestId"],
                            "feed_audience": audience,
                            "user_facing_status": "partial",
                        }
                    )
                },
            )

    with request_bulk.db.engine.connect() as connection:
        connection.exec_driver_sql(
            (MIGRATIONS / "263_drive_request_no_match.sql").read_text().replace("%", "%%")
        )
        connection.commit()

    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO feed_events(source_domain,event_type,metadata)
            VALUES ('connected_systems','document_share_outcome',CAST(:metadata AS jsonb))"""),
            {
                "metadata": json.dumps(
                    {
                        "request_id": empty["requestId"],
                        "feed_audience": "recipient",
                        "user_facing_status": "no_match",
                    }
                )
            },
        )
        statuses = dict(
            connection.execute(
                text("""SELECT request_id::text,status FROM drive_share_requests
            WHERE request_id IN (:empty,:found)"""),
                {"empty": empty["requestId"], "found": found["requestId"]},
            ).all()
        )
        feed = {
            (request_id, audience): status
            for request_id, audience, status in connection.execute(
                text("""SELECT metadata->>'request_id',metadata->>'feed_audience',
              metadata->>'user_facing_status' FROM feed_events""")
            ).all()
        }
    assert statuses == {empty["requestId"]: "no_match", found["requestId"]: "partial"}
    assert feed == {
        (empty["requestId"], "owner"): "no_match",
        (empty["requestId"], "recipient"): "no_files_shared",
        (found["requestId"], "owner"): "partial",
    }

    with request_bulk.db.engine.connect() as connection:
        connection.exec_driver_sql(
            (MIGRATIONS / "rollback/263_drive_request_no_match.rollback.sql")
            .read_text()
            .replace("%", "%%")
        )
        connection.commit()
    with request_bulk.db.engine.begin() as connection:
        assert dict(
            connection.execute(
                text("""SELECT request_id::text,status FROM drive_share_requests
                WHERE request_id IN (:empty,:found)"""),
                {"empty": empty["requestId"], "found": found["requestId"]},
            ).all()
        ) == {empty["requestId"]: "partial", found["requestId"]: "partial"}
        assert set(
            connection.execute(
                text("""SELECT metadata->>'user_facing_status' FROM feed_events""")
            ).scalars()
        ) == {"partial"}


def _make_frozen_request_undated(
    sharing, request_id, *, purpose="Standup notes from the last 3 days"
):
    """Model a pre-upgrade request whose date period was never frozen."""
    with sharing.db.engine.begin() as connection:
        row = (
            connection.execute(
                text("SELECT request_envelope FROM drive_share_requests WHERE request_id=:request"),
                {"request": request_id},
            )
            .mappings()
            .one()
        )
        private = sharing.sharing_cipher.open(
            row["request_envelope"],
            user_id="owner",
            resource_id=request_id,
            purpose="request",
        )
        private["purpose"] = {
            "purpose": purpose,
            "periodStart": None,
            "periodEnd": None,
        }
        connection.execute(
            text("""UPDATE drive_share_requests SET request_envelope=CAST(:envelope AS jsonb)
            WHERE request_id=:request"""),
            {
                "request": request_id,
                "envelope": json.dumps(
                    sharing.sharing_cipher.seal(
                        private,
                        user_id="owner",
                        resource_id=request_id,
                        purpose="request",
                    )
                ),
            },
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("purpose", ["Standup notes from the last 3 days", "Financial plan"])
async def test_undated_frozen_request_cannot_approve(request_bulk, sharing, purpose):
    unapproved = await _request(sharing)
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=_search(request_bulk, request_id=unapproved["requestId"], count=1),
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=unapproved["requestId"],
    )
    _make_frozen_request_undated(sharing, unapproved["requestId"], purpose=purpose)
    with pytest.raises(DriveSharingError, match="date_range_required"):
        await request_bulk.approve(
            user_id="owner",
            share_id=review["shareId"],
            revision=review["revision"],
            review_digest=review["reviewDigest"],
        )


@pytest.mark.asyncio
async def test_undated_approved_effect_skipped_before_dispatch(request_bulk, sharing):
    queued = await _request(sharing)
    queued_review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=_search(request_bulk, request_id=queued["requestId"], count=1),
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=queued["requestId"],
    )
    await request_bulk.approve(
        user_id="owner",
        share_id=queued_review["shareId"],
        revision=queued_review["revision"],
        review_digest=queued_review["reviewDigest"],
    )
    _make_frozen_request_undated(sharing, queued["requestId"])
    assert (
        await request_bulk.claim(
            user_id="owner",
            share_id=queued_review["shareId"],
            position=1,
            recipient_user_id="recipient",
        )
        is None
    )
    with request_bulk.db.engine.begin() as connection:
        effect = connection.execute(
            text("""SELECT state,safe_error_code FROM drive_bulk_share_effects
            WHERE share_id=:share AND position=1"""),
            {"share": queued_review["shareId"]},
        ).one()
    assert effect == ("skipped", "date_range_required")


async def _complete_shared_drive_search(bulk, sharing, *, request_id):
    """Collect 25 personal and 500 shared-drive files through checkpointed pages."""
    context = await sharing.request_bulk_context(user_id="owner", request_id=request_id, start=True)
    store = DriveOwnerSearchStore(db=bulk.db)
    arguments = {"query": "name contains 'Standup'", "orderBy": "modifiedTime desc"}
    today = datetime.now(UTC).date()
    period = {
        "start": (today - timedelta(days=90)).isoformat(),
        "end": today.isoformat(),
        "timezone": "UTC",
    }
    older_modified = (today - timedelta(days=120)).isoformat() + "T00:00:00Z"
    state, created = await store.create(
        user_id="owner",
        client_request_id=request_id,
        request={"query": "Standup notes from last 3 months", "timezone": "UTC"},
        confirmed=True,
        checkpoint={
            "request": {"query": "Standup notes from last 3 months", "timezone": "UTC"},
            "request_origin_id": request_id,
            "request_revision": context["revision"],
            "request_shareability_version": 1,
            "arguments": arguments,
            "queries": [{"arguments": arguments}],
            "query_index": 0,
            "requested_period": period,
            "phase": "user",
            "page_token": None,
            "drive_page_token": None,
            "drives": [],
            "drive_index": 0,
            "seen_tokens": [],
            "drive_tokens": [],
        },
    )
    assert created
    seen_shared_pages = []

    async def read(*, user_id, tool_name, arguments):
        assert user_id == "owner"
        if tool_name == "list_shared_drives":
            return ExternalMcpToolResult(
                False, {"drives": [{"id": "shared-drive-1"}], "nextPageToken": None}, False
            )
        if tool_name == "get_file_metadata":
            assert arguments == {"fileId": "standup-file-525"}
            return ExternalMcpToolResult(
                False,
                {
                    "file": {
                        "id": "standup-file-525",
                        "title": "Hushh Team Standup Notes",
                        "mimeType": "application/vnd.google-apps.document",
                        "modifiedTime": older_modified,
                        "capabilities": {"canShare": True},
                    }
                },
                False,
            )
        assert tool_name == "search_files"
        page_size = arguments["pageSize"]
        assert page_size == 100
        if "driveId" not in arguments:
            numbers = range(1, 26)
            next_token = None
        else:
            assert arguments["driveId"] == "shared-drive-1"
            offset = int(arguments.get("pageToken") or "0")
            seen_shared_pages.append(offset)
            numbers = range(26 + offset, min(26 + offset + page_size, 526))
            next_token = str(offset + page_size) if offset + page_size < 500 else None
        files = [
            {
                "id": f"standup-file-{number}",
                "title": f"Standup notes {today.isoformat()} #{number}",
                "mimeType": "application/vnd.google-apps.document",
                "modifiedTime": older_modified
                if number == 525
                else today.isoformat() + "T00:00:00Z",
                "capabilities": {"canShare": True},
            }
            for number in numbers
        ]
        if 525 in numbers:
            files[-1] = {
                "id": "standup-shortcut-525",
                "title": f"Standup notes {today.isoformat()} #525",
                "mimeType": "application/vnd.google-apps.shortcut",
                "modifiedTime": older_modified,
                "capabilities": {"canShare": True},
                "shortcutDetails": {
                    "targetId": "standup-file-525",
                    "targetMimeType": "application/vnd.google-apps.document",
                },
            }
        return ExternalMcpToolResult(
            False,
            {"files": files, "nextPageToken": next_token, "incompleteSearch": False},
            False,
        )

    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace(read_tool=read))
    for _ in range(12):
        status = await store.status(user_id="owner", job_id=state["jobId"])
        if not status["canStop"]:
            break
        await service.run_one(user_id="owner", job_id=state["jobId"])
    final = await store.status(user_id="owner", job_id=state["jobId"])
    assert final["status"] == "completed"
    assert final["matched"] == 525
    assert final["incompleteSearch"] is False
    assert seen_shared_pages == list(range(0, 500, 100))
    last = await store.reference(user_id="owner", job_id=state["jobId"], position=525)
    assert last["id"] == "standup-file-525"
    assert last["shortcutName"].startswith("Standup notes")
    return state["jobId"]


def _recipient(user_id, email):
    return {
        "userId": user_id,
        "name": user_id,
        "email": email,
        "subject": "1234567" if user_id == "recipient" else f"subject-{user_id}",
        "kind": "google_provider" if user_id == "recipient" else "verified_email",
    }


async def _trusted_request(sharing, *, purpose_text="Standup notes from last 3 months"):
    today = datetime.now(UTC).date()
    return await sharing.create_request(
        recipient=VerifiedGoogleRecipient(
            "trusted-member",
            "subject-trusted-member",
            "trusted@example.invalid",
            datetime.now(UTC),
            "verified_email",
        ),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        expected_quote_version=1,
        purpose=ShareRequestPurpose(
            purpose=purpose_text,
            periodStart=(today - timedelta(days=90)).isoformat(),
            periodEnd=today.isoformat(),
        ),
    )


async def _trusted_review(bulk, sharing, *, paid=True):
    request = await _trusted_request(sharing)
    review = await bulk.create_review(
        user_id="owner",
        search_job_id=_search(
            bulk, request_id=request["requestId"], count=1, selection=FILE_ACTIVITY_SELECTION
        ),
        client_request_id=str(uuid4()),
        recipients=[_recipient("trusted-member", "trusted@example.invalid")],
        excluded=[],
        origin_request_id=request["requestId"],
        selected_positions=[1],
    )
    with bulk.db.engine.begin() as connection:
        origin = bulk._row(
            connection,
            "SELECT * FROM drive_share_requests WHERE request_id=:request",
            {"request": request["requestId"]},
        )
        assert sharing._open_request(origin)["trusted_auto"] is True
        assert origin["payment_required"] is True
        if paid:
            connection.execute(
                text("""INSERT INTO drive_request_payment_orders
                  (stripe_mode,request_id,user_id,requester_user_id,status,paid_at)
                  VALUES ('test',:request,'owner','trusted-member','paid',clock_timestamp())"""),
                {"request": request["requestId"]},
            )
    return review


@pytest.mark.asyncio
@pytest.mark.parametrize("autoshare_search", [True, False])
async def test_paid_autoshare_statement_request_is_granted_after_payment(
    request_bulk, sharing, autoshare_search
):
    """A Trusted "Schwab statements" request: pay, then One shares the file."""
    request_id = (await _trusted_request(sharing, purpose_text="Schwab statements for September"))[
        "requestId"
    ]
    today = datetime.now(UTC).date()
    selection = (
        {
            # The autoshare date selection create_for_request froze.
            "request_selection_version": 2,
            "request_time_intent": "document_coverage",
            "request_owner_review_required": False,
            "request_selection_policy": "title_then_created_then_modified_v1",
            "authority_mode": "trusted_auto",
            "agent_package_required": False,
            "requested_period": {
                "start": (today - timedelta(days=90)).isoformat(),
                "end": today.isoformat(),
                "timezone": "UTC",
            },
        }
        if autoshare_search
        else {
            "request_selection_version": 2,
            "request_time_intent": "document_coverage",
            "request_owner_review_required": True,
        }
    )
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=_search(request_bulk, request_id=request_id, count=1, selection=selection),
        client_request_id=str(uuid4()),
        recipients=[_recipient("trusted-member", "trusted@example.invalid")],
        excluded=[],
        origin_request_id=request_id,
        selected_positions=[1],
    )
    with request_bulk.db.engine.begin() as connection:
        origin = request_bulk._row(
            connection,
            "SELECT * FROM drive_share_requests WHERE request_id=:request",
            {"request": request_id},
        )
        private = sharing._open_request(origin)
        assert (private["trusted_auto"], private["request_flow"]) == (True, "oct17_autoshare")
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (stripe_mode,request_id,user_id,requester_user_id,status,paid_at)
              VALUES ('test',:request,'owner','trusted-member','paid',clock_timestamp())"""),
            {"request": request_id},
        )
    approve = request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
        approval_source="trusted_auto",
    )
    if not autoshare_search:
        # Without the autoshare selection a statement still needs the owner.
        with pytest.raises(DriveSharingError, match="trusted_request_unavailable"):
            await approve
        return
    await approve
    grant = await request_bulk.claim(
        user_id="owner", share_id=review["shareId"], position=1, recipient_user_id="trusted-member"
    )
    assert grant is not None


async def _paid_partial_progressive_request(bulk, sharing, *, batches=1):
    request_id = (await _trusted_request(sharing))["requestId"]
    search = _search(
        bulk, request_id=request_id, count=batches * 2, selection=FILE_ACTIVITY_SELECTION
    )
    with bulk.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (stripe_mode,request_id,user_id,requester_user_id,status,paid_at)
              VALUES ('test',:request,'owner','trusted-member','paid',clock_timestamp())"""),
            {"request": request_id},
        )
    reviews = []
    for index in range(batches):
        review = await bulk.create_review(
            user_id="owner",
            search_job_id=search,
            client_request_id=str(uuid4()),
            recipients=[_recipient("trusted-member", "trusted@example.invalid")],
            excluded=[],
            origin_request_id=request_id,
            selected_positions=[index * 2 + 1, index * 2 + 2],
        )
        await bulk.approve(
            user_id="owner",
            share_id=review["shareId"],
            revision=review["revision"],
            review_digest=review["reviewDigest"],
            approval_source="trusted_auto",
        )
        missing = await bulk.claim(
            user_id="owner",
            share_id=review["shareId"],
            position=1,
            recipient_user_id="trusted-member",
        )
        await bulk.release(missing, error="provider_unavailable")
        existing = await bulk.claim(
            user_id="owner",
            share_id=review["shareId"],
            position=2,
            recipient_user_id="trusted-member",
        )
        await bulk.settle(existing, state="preexisting", receipt={"managed": False})
        reviews.append(review)
    assert (await sharing.request_status(user_id="owner", request_id=request_id))[
        "status"
    ] == "partial"
    return request_id, reviews


@pytest.mark.asyncio
@pytest.mark.parametrize("batches", [1, 2])
async def test_paid_partial_progressive_retry_preserves_sibling_approvals_and_outcomes(
    request_bulk, sharing, batches
):
    request_id, reviews = await _paid_partial_progressive_request(
        request_bulk, sharing, batches=batches
    )
    with request_bulk.db.engine.begin() as connection:
        request_revision = connection.execute(
            text("SELECT revision FROM drive_share_requests WHERE request_id=:request"),
            {"request": request_id},
        ).scalar_one()
        paid_at = connection.execute(
            text("SELECT paid_at FROM drive_request_payment_orders WHERE request_id=:request"),
            {"request": request_id},
        ).scalar_one()
        existing_before = list(
            connection.execute(
                text("""SELECT e.share_id,e.state,e.attempts,e.receipt_envelope,e.updated_at
              FROM drive_bulk_share_effects e JOIN drive_bulk_shares b ON b.share_id=e.share_id
              WHERE b.origin_request_id=:request AND e.position=2 ORDER BY e.share_id"""),
                {"request": request_id},
            ).mappings()
        )
    for index, original in enumerate(reviews):
        review = await request_bulk.review(user_id="owner", share_id=original["shareId"])
        assert review["canRetry"] is True
        retried = await request_bulk.retry(
            user_id="owner",
            share_id=review["shareId"],
            revision=review["revision"],
            review_digest=review["reviewDigest"],
        )
        assert retried["reviewDigest"] == original["reviewDigest"]
        assert retried["counts"]["pending"] == retried["counts"]["alreadyShared"] == 1
        with request_bulk.db.engine.begin() as connection:
            assert connection.execute(
                text("SELECT status,revision FROM drive_share_requests WHERE request_id=:request"),
                {"request": request_id},
            ).one() == ("pending", request_revision)
            assert connection.execute(
                text("""SELECT bool_and(approval_source='trusted_auto'
                  AND origin_request_revision=:revision) FROM drive_bulk_shares
                  WHERE origin_request_id=:request"""),
                {"request": request_id, "revision": request_revision},
            ).scalar_one()
        # Already confirmed access is never dispatched again during recovery.
        assert (
            await request_bulk.claim(
                user_id="owner",
                share_id=review["shareId"],
                position=2,
                recipient_user_id="trusted-member",
            )
            is None
        )
        job = await request_bulk.claim(
            user_id="owner",
            share_id=review["shareId"],
            position=1,
            recipient_user_id="trusted-member",
        )
        assert job is not None
        await request_bulk.mark_dispatching(job)
        await request_bulk.settle(job, state="succeeded", receipt={"managed": True})
        expected = "completed" if index == batches - 1 else "partial"
        assert (await sharing.request_status(user_id="owner", request_id=request_id))[
            "status"
        ] == expected
    await request_bulk.refresh_request(user_id="owner", request_id=request_id)
    with request_bulk.db.engine.begin() as connection:
        assert connection.execute(
            text(
                "SELECT status,paid_at FROM drive_request_payment_orders WHERE request_id=:request"
            ),
            {"request": request_id},
        ).one() == ("paid", paid_at)
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders WHERE request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            == 1
        )
        assert (
            list(
                connection.execute(
                    text("""SELECT e.share_id,e.state,e.attempts,e.receipt_envelope,e.updated_at
              FROM drive_bulk_share_effects e JOIN drive_bulk_shares b ON b.share_id=e.share_id
              WHERE b.origin_request_id=:request AND e.position=2 ORDER BY e.share_id"""),
                    {"request": request_id},
                ).mappings()
            )
            == existing_before
        )
        # One outcome for each actual terminal transition, per audience. A
        # repeated refresh cannot duplicate it, and no authority revision moves.
        assert list(
            connection.execute(
                text("""SELECT revision,count(*) FROM drive_share_events
              WHERE request_id=:request AND event_type='document_share_outcome'
              GROUP BY revision ORDER BY revision"""),
                {"request": request_id},
            )
        ) == [(request_revision + i, 2) for i in range(batches + 1)]


def test_a_final_payout_closes_retry_and_an_unknown_refund_is_never_refunded():
    asked = datetime(2026, 10, 1, tzinfo=UTC)

    def recovery(*, refund=None, payout=None, review_requested_at=None):
        return requester_recovery_view(
            request_status="partial",
            review_requested_at=review_requested_at,
            outcomes={("succeeded", None): 1, ("skipped", "provider_unavailable"): 1},
            retryable_count=1,
            retryable_updated_at=asked - timedelta(minutes=5),
            request_open=True,
            paid=True,
            refund=refund,
            payout=payout,
            order_amount_cents=1000,
        )

    assert recovery()["ownerRetry"]["state"] == "available"
    final = {
        "status": "awaiting_refund",
        "gross_amount_cents": 1000,
        "expected_files": 2,
        "confirmed_files": 1,
        "refund_amount_cents": 500,
        "finalized_at": asked,
    }
    # Finalization froze the delivered count: no retry is offered after it.
    closed = recovery(payout=final, refund={"status": "unknown", "amount_cents": 500})
    assert closed["ownerRetry"] == {
        "state": "unavailable",
        "retryableCount": 0,
        "requestedAt": None,
    }
    assert closed["refund"] == {
        "state": "pending",
        "amountCents": 500,
        "grossCents": 1000,
        "expectedFiles": 2,
        "confirmedFiles": 1,
    }
    # Owed but not started is pending too; only a provider success is a refund.
    assert recovery(payout=final)["refund"]["state"] == "pending"
    done = recovery(
        payout=final, refund={"status": "succeeded", "amount_cents": 500}, review_requested_at=asked
    )
    assert done["refund"]["state"] == "succeeded"
    assert owner_review_request_view(done, review_request_count=1) == {
        "requestedAt": asked.isoformat(),
        "count": 1,
        "unsharedCount": 1,
        "refund": {"state": "succeeded", "amountCents": 500},
    }


@pytest.mark.asyncio
async def test_requester_review_ask_follows_the_owner_retry_and_stops_at_three(
    request_bulk, sharing
):
    from hushh_mcp.services.drive_request_requester_store import request_review

    request_id, (original,) = await _paid_partial_progressive_request(request_bulk, sharing)
    projections = DriveSuggestionStore(db=sharing.db, authority_key="synthetic-ledger-key")

    async def views(user_id):
        snapshot = await projections.delivery_snapshot(
            user_id=user_id, request_id=request_id, views=True
        )
        return snapshot["result"]

    def ask(user_id="trusted-member"):
        return request_review(sharing, user_id=user_id, request_id=request_id)

    def owner_events():
        with sharing.db.engine.begin() as connection:
            return connection.execute(
                text("""SELECT user_id,count(*) FROM drive_share_events
                  WHERE request_id=:request AND event_type='document_share_review_requested'
                  GROUP BY user_id"""),
                {"request": request_id},
            ).all()

    assert (await views("trusted-member"))["recovery"] == {
        "undeliveredCount": 1,
        "reasons": [{"reasonCode": "provider_unavailable", "count": 1}],
        "ownerRetry": {"state": "available", "retryableCount": 1, "requestedAt": None},
        "refund": {
            "state": "none",
            "amountCents": None,
            "grossCents": 1000,
            "expectedFiles": None,
            "confirmedFiles": None,
        },
    }
    owner = await views("owner")
    assert "recovery" not in owner and "reviewRequest" not in owner
    with pytest.raises(DriveSharingError, match="request_unavailable"):
        await ask("owner")

    first = await ask()
    assert first["ownerRetry"] == {"state": "requested", "retryableCount": 1}
    assert first["refund"] == {"state": "none", "amountCents": None}
    # A repeat before the owner acts is the same ask: no second owner event.
    assert await ask() == first
    assert owner_events() == [("owner", 1)]
    assert (await views("owner"))["reviewRequest"] == {
        "requestedAt": first["reviewRequestedAt"],
        "count": 1,
        "unsharedCount": 1,
        "refund": {"state": "none", "amountCents": None},
    }

    # The owner retries: the requester sees it running and the notice clears.
    review = await request_bulk.review(user_id="owner", share_id=original["shareId"])
    await request_bulk.retry(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    assert (await views("trusted-member"))["recovery"]["ownerRetry"]["state"] == "retrying"
    assert "reviewRequest" not in await views("owner")
    with pytest.raises(DriveSharingError, match="review_not_available"):
        await ask()

    # Google fails again: a new ask is its own owner event.
    job = await request_bulk.claim(
        user_id="owner", share_id=review["shareId"], position=1, recipient_user_id="trusted-member"
    )
    await request_bulk.release(job, error="provider_unavailable")
    assert (await views("trusted-member"))["recovery"]["ownerRetry"]["state"] == "available"
    assert (await ask())["ownerRetry"]["state"] == "requested"
    assert owner_events() == [("owner", 2)]

    # Three asks per request: a fourth is refused and emits nothing.
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests SET review_request_count=3,
              review_requested_at=review_requested_at-INTERVAL '1 day'
              WHERE request_id=:request"""),
            {"request": request_id},
        )
    assert (await views("trusted-member"))["recovery"]["ownerRetry"]["state"] == "available"
    with pytest.raises(DriveSharingError, match="review_limit_reached"):
        await ask()
    assert owner_events() == [("owner", 2)]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "blocker",
    [
        """UPDATE connections SET status='removed'
           WHERE user_a_id='owner' AND user_b_id='trusted-member'""",
        # The batch's Drive connection is no longer the owner's verified one.
        """UPDATE user_external_connector_connections SET validation_state='policy_drift'
           WHERE user_id='owner' AND connector_id='google_drive'""",
        # A payment under reconciliation never authorizes another grant.
        """UPDATE drive_request_payment_orders SET reconciliation_required=TRUE,
             reconciliation_reason='authority_changed',reconciliation_at=clock_timestamp()
           WHERE requester_user_id='trusted-member'""",
        # The owner's Drive sharing is switched off.
        None,
    ],
    ids=["disconnected", "drive_unverified", "payment_reconciling", "owner_sharing_off"],
)
async def test_review_ask_needs_an_owner_retry_that_can_still_run(
    request_bulk, sharing, blocker, monkeypatch
):
    from hushh_mcp.services.drive_request_requester_store import request_review

    request_id, (original,) = await _paid_partial_progressive_request(request_bulk, sharing)
    projections = DriveSuggestionStore(db=sharing.db, authority_key="synthetic-ledger-key")
    if blocker is None:
        monkeypatch.setattr(
            DriveBulkShareStore, "_owner_grants_enabled", staticmethod(lambda _user_id: False)
        )
    else:
        with sharing.db.engine.begin() as connection:
            connection.execute(text(blocker))
    # The owner has no Retry here, so the requester is offered no review.
    owner_view = await request_bulk.review(user_id="owner", share_id=original["shareId"])
    assert owner_view["canRetry"] is False
    snapshot = await projections.delivery_snapshot(
        user_id="trusted-member", request_id=request_id, views=True
    )
    assert snapshot["result"]["recovery"]["ownerRetry"] == {
        "state": "unavailable",
        "retryableCount": 0,
        "requestedAt": None,
    }
    with pytest.raises(DriveSharingError, match="review_not_available"):
        await request_review(sharing, user_id="trusted-member", request_id=request_id)
    with sharing.db.engine.begin() as connection:
        assert connection.execute(
            text("""SELECT review_request_count,review_requested_at IS NULL
              FROM drive_share_requests WHERE request_id=:request"""),
            {"request": request_id},
        ).one() == (0, True)


@pytest.mark.asyncio
async def test_requester_without_google_account_is_told_to_link_one(request_bulk, sharing):
    """B has only a verified email. Google refuses the silent share; B sees why."""
    from hushh_mcp.services.drive_bulk_share_worker import DriveBulkShareWorker
    from hushh_mcp.services.google_drive_permission_adapter import (
        DrivePermissionError,
        PermissionSnapshot,
    )

    request_id = (await _trusted_request(sharing))["requestId"]
    search = _search(
        request_bulk, request_id=request_id, count=2, selection=FILE_ACTIVITY_SELECTION
    )
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (stripe_mode,request_id,user_id,requester_user_id,status,paid_at)
              VALUES ('test',:request,'owner','trusted-member','paid',clock_timestamp())"""),
            {"request": request_id},
        )
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=str(uuid4()),
        recipients=[_recipient("trusted-member", "trusted@example.invalid")],
        excluded=[],
        origin_request_id=request_id,
        selected_positions=[1, 2],
    )
    await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
        approval_source="trusted_auto",
    )
    with request_bulk.db.engine.begin() as connection:
        generation = connection.execute(
            text("SELECT connection_generation FROM drive_bulk_shares WHERE share_id=:share"),
            {"share": review["shareId"]},
        ).scalar_one()
    # Google's answer with notification email off for an address that has no
    # Google account: invalidSharingRequest, and no grant exists afterwards.
    adapter = SimpleNamespace(
        inspect_shareable=AsyncMock(),
        list_permissions=AsyncMock(return_value=PermissionSnapshot(())),
        create_reader=AsyncMock(
            side_effect=DrivePermissionError(
                "permission_outcome_unknown",
                outcome_unknown=True,
                share_hint="recipient_needs_google_account",
            )
        ),
    )
    worker = DriveBulkShareWorker(
        store=request_bulk,
        adapter=adapter,
        oauth=SimpleNamespace(
            current_credential=AsyncMock(
                return_value=(
                    {"connection_generation": generation},
                    {
                        "accessToken": "synthetic-token",
                        "subject": "owner-google",
                        "oauthClientId": "synthetic-client",
                    },
                )
            )
        ),
        verify_recipient=AsyncMock(),
        wake=AsyncMock(),
    )
    rows = [
        {
            "user_id": "owner",
            "share_id": review["shareId"],
            "position": position,
            "recipient_user_id": "trusted-member",
        }
        for position in (1, 2)
    ]
    projections = DriveSuggestionStore(db=sharing.db, authority_key="synthetic-ledger-key")

    async def requester_view():
        snapshot = await projections.delivery_snapshot(
            user_id="trusted-member", request_id=request_id, views=True
        )
        return snapshot["result"]

    assert [await worker._effect(row) for row in rows] == ["unknown", "unknown"]
    # Until reconciliation reads the ACL, B is told the outcome is being checked.
    checking = await requester_view()
    assert checking["counts"]["unknown"] == 2
    assert checking["issues"] == [{"reasonCode": "permission_outcome_unknown", "count": 2}]
    assert "issueDetails" not in checking
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_share_effects
              SET next_at=clock_timestamp()-INTERVAL '1 second' WHERE share_id=:share"""),
            {"share": review["shareId"]},
        )
    assert [await worker._effect(row) for row in rows] == ["failed", "failed"]
    assert adapter.create_reader.await_count == 2
    view = await requester_view()
    assert view["sharedCount"] == 0 and view["counts"]["failed"] == 2
    # Installed apps parse only the codes they shipped with: the exact reason
    # is additive, beside its nearest known code.
    assert view["issues"] == [{"reasonCode": "permission_rejected", "count": 2}]
    assert view["issueDetails"] == [{"reasonCode": "recipient_needs_google_account", "count": 2}]
    assert view["recovery"]["reasons"] == [
        {"reasonCode": "recipient_needs_google_account", "count": 2}
    ]
    # An owner retry cannot help until B links a Google account.
    assert view["recovery"]["ownerRetry"]["state"] == "unavailable"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "blocker",
    [
        "trust",
        "background",
        "refunded",
        "unpaid",
        "unknown",
        "dispatching",
        "receipt",
        "lease",
        "generation",
        "revision",
        "expired",
        "dates",
    ],
)
async def test_paid_progressive_retry_rechecks_authority_and_never_replays_uncertain_effects(
    request_bulk, sharing, blocker
):
    request_id, (original,) = await _paid_partial_progressive_request(request_bulk, sharing)
    with request_bulk.db.engine.begin() as connection:
        if blocker == "trust":
            connection.execute(
                text(
                    "UPDATE one_location_circle_memberships SET status='removed' WHERE user_id='trusted-member'"
                )
            )
        elif blocker == "background":
            connection.execute(
                text("""INSERT INTO drive_live_preferences(user_id,connection_generation,background_enabled)
              VALUES('owner',1,FALSE) ON CONFLICT(user_id) DO UPDATE SET background_enabled=FALSE""")
            )
        elif blocker in {"refunded", "unpaid"}:
            connection.execute(
                text("""UPDATE drive_request_payment_orders SET status=:status,
                  paid_at=CASE WHEN :status='refunded' THEN paid_at ELSE NULL END
                  WHERE request_id=:request"""),
                {
                    "request": request_id,
                    "status": "refunded" if blocker == "refunded" else "awaiting_payment",
                },
            )
        elif blocker in {"unknown", "dispatching", "receipt"}:
            connection.execute(
                text("""UPDATE drive_bulk_share_effects SET state=:state,
                  receipt_envelope=CASE WHEN :receipt THEN CAST(:envelope AS jsonb) ELSE NULL END
                  WHERE share_id=:share AND position=1"""),
                {
                    "share": original["shareId"],
                    "state": "skipped" if blocker == "receipt" else blocker,
                    "receipt": blocker == "receipt",
                    "envelope": request_bulk._seal(
                        {"managed": False},
                        user_id="owner",
                        resource_id="synthetic",
                        purpose="receipt",
                    ),
                },
            )
        elif blocker == "lease":
            connection.execute(
                text("""UPDATE drive_bulk_share_effects
                  SET lease_id=:lease,lease_expires_at=clock_timestamp()+INTERVAL '1 minute'
                  WHERE share_id=:share AND position=1"""),
                {"share": original["shareId"], "lease": str(uuid4())},
            )
        elif blocker == "generation":
            connection.execute(
                text("""UPDATE user_external_connector_connections
              SET connection_generation=connection_generation+1 WHERE user_id='owner' AND connector_id='google_drive'""")
            )
        elif blocker == "revision":
            connection.execute(
                text(
                    "UPDATE drive_share_requests SET revision=revision+1 WHERE request_id=:request"
                ),
                {"request": request_id},
            )
        elif blocker == "expired":
            connection.execute(
                text("""UPDATE drive_share_requests
              SET created_at=clock_timestamp()-INTERVAL '2 days',expires_at=clock_timestamp()-INTERVAL '1 day'
              WHERE request_id=:request"""),
                {"request": request_id},
            )
        else:
            row = request_bulk._row(
                connection,
                "SELECT * FROM drive_share_requests WHERE request_id=:request",
                {"request": request_id},
            )
            private = sharing._open_request(row)
            private["purpose"].pop("periodStart")
            connection.execute(
                text(
                    "UPDATE drive_share_requests SET request_envelope=CAST(:envelope AS jsonb) WHERE request_id=:request"
                ),
                {
                    "request": request_id,
                    "envelope": request_bulk._seal(
                        private, user_id="owner", resource_id=request_id, purpose="request"
                    ),
                },
            )
        before = list(
            connection.execute(
                text(
                    "SELECT position,state,attempts,updated_at FROM drive_bulk_share_effects WHERE share_id=:share ORDER BY position"
                ),
                {"share": original["shareId"]},
            )
        )
    review = await request_bulk.review(user_id="owner", share_id=original["shareId"])
    assert review["canRetry"] is False
    with pytest.raises((DriveSharingError, DriveReadError)):
        await request_bulk.retry(
            user_id="owner",
            share_id=review["shareId"],
            revision=review["revision"],
            review_digest=review["reviewDigest"],
        )
    with request_bulk.db.engine.begin() as connection:
        assert (
            list(
                connection.execute(
                    text(
                        "SELECT position,state,attempts,updated_at FROM drive_bulk_share_effects WHERE share_id=:share ORDER BY position"
                    ),
                    {"share": original["shareId"]},
                )
            )
            == before
        )
        assert (
            connection.execute(
                text("SELECT status FROM drive_share_requests WHERE request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            == "partial"
        )


@pytest.mark.asyncio
async def test_new_trusted_request_cannot_queue_or_claim_grants_until_paid(request_bulk, sharing):
    review = await _trusted_review(request_bulk, sharing, paid=False)
    with request_bulk.db.engine.begin() as connection:
        request_id = connection.execute(
            text("SELECT origin_request_id FROM drive_bulk_shares WHERE share_id=:share"),
            {"share": review["shareId"]},
        ).scalar_one()
    approval = {
        "user_id": "owner",
        "share_id": review["shareId"],
        "revision": review["revision"],
        "review_digest": review["reviewDigest"],
    }
    with pytest.raises(DriveSharingError, match="payment_required"):
        await request_bulk.approve(**approval)
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_effects")).scalar_one()
            == 0
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (stripe_mode,request_id,user_id,requester_user_id,status)
              VALUES ('test',:request,'owner','trusted-member','awaiting_payment')"""),
            {"request": request_id},
        )
    assert str(request_id) in {
        row["request_id"]
        for row in await DriveRequestPaymentService(db=sharing.db).due_checkout_orders(limit=20)
    }
    with pytest.raises(DriveSharingError, match="payment_required"):
        await request_bulk.approve(**approval)
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_request_payment_orders
              SET status='paid',paid_at=clock_timestamp() WHERE request_id=:request"""),
            {"request": request_id},
        )
    await request_bulk.approve(**approval)
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_effects")).scalar_one()
            == 1
        )
        connection.execute(
            text(
                "UPDATE drive_request_payment_orders SET status='refunded' WHERE request_id=:request"
            ),
            {"request": request_id},
        )
    # A refunded order can never pay for this grant again. Every grant still
    # rechecks payment, and the queued grant is released once instead of
    # being refused on every drain; a later order change cannot revive it.
    assert (
        await request_bulk.claim(
            user_id="owner",
            share_id=review["shareId"],
            position=1,
            recipient_user_id="trusted-member",
        )
        is None
    )
    with request_bulk.db.engine.begin() as connection:
        assert tuple(
            connection.execute(
                text("""SELECT state,safe_error_code,lease_id FROM drive_bulk_share_effects
                WHERE share_id=:share"""),
                {"share": review["shareId"]},
            ).one()
        ) == ("skipped", "stopped", None)
        connection.execute(
            text("UPDATE drive_request_payment_orders SET status='paid' WHERE request_id=:request"),
            {"request": request_id},
        )
    assert review["shareId"] not in {str(row["share_id"]) for row in await request_bulk.due()}
    assert (
        await request_bulk.claim(
            user_id="owner",
            share_id=review["shareId"],
            position=1,
            recipient_user_id="trusted-member",
        )
        is None
    )


@pytest.mark.asyncio
async def test_owner_can_stop_paid_frozen_request_before_any_grant(request_bulk, sharing):
    review = await _trusted_review(request_bulk, sharing)
    with sharing.db.engine.begin() as connection:
        request_id = str(
            connection.execute(
                text("SELECT origin_request_id FROM drive_bulk_shares WHERE share_id=:share"),
                {"share": review["shareId"]},
            ).scalar_one()
        )
        connection.execute(
            text("""UPDATE drive_request_payment_orders
              SET stripe_payment_intent_id='pi_paid_frozen_stop'
              WHERE request_id=:request"""),
            {"request": request_id},
        )
        assert (
            connection.execute(
                text("SELECT status FROM drive_share_requests WHERE request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            == "pending"
        )
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_effects")).scalar_one()
            == 0
        )

    store = DriveSuggestionStore(db=sharing.db, authority_key="synthetic-ledger-key")
    before = await store.delivery_snapshot(user_id="owner", request_id=request_id)
    assert before["result"]["canStopAccess"] is True
    assert "bulkShareId" not in before["result"]

    prepared = await store.prepare_revocation(user_id="owner", generation=1, request_id=request_id)
    assert prepared["affectedCount"] == 0
    stopped = await store.confirm_revocation(
        user_id="owner",
        generation=1,
        request_id=request_id,
        revision=prepared["revision"],
        directive_id=prepared["directiveId"],
        review_digest=prepared["reviewDigest"],
        grant_ids=[],
        confirmed=True,
    )
    assert stopped["revocationStatus"] == "pending"
    after = await store.delivery_snapshot(user_id="owner", request_id=request_id)
    assert after["result"]["canStopAccess"] is False
    assert after["result"]["accessStopStatus"] == "removed"
    with sharing.db.engine.begin() as connection:
        assert (
            connection.execute(
                text(
                    "SELECT access_stop_requested_at IS NOT NULL FROM drive_share_requests WHERE request_id=:request"
                ),
                {"request": request_id},
            ).scalar_one()
            is True
        )
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_effects")).scalar_one()
            == 0
        )
        refunds = _claim_refunds(DriveRequestPaymentService(db=sharing.db), connection, limit=1)
        assert [item["request_id"] for item in refunds] == [request_id]

    with pytest.raises(DriveSharingError, match="request_changed"):
        await request_bulk.approve(
            user_id="owner",
            share_id=review["shareId"],
            revision=review["revision"],
            review_digest=review["reviewDigest"],
            approval_source="trusted_auto",
        )


async def _approved_request(bulk, sharing, count):
    request = await _request(sharing)
    review = await bulk.create_review(
        user_id="owner",
        search_job_id=_search(bulk, request_id=request["requestId"], count=count),
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request["requestId"],
    )
    await bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    with bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_request_payment_orders
            SET status='paid',paid_at=clock_timestamp()
            WHERE request_id=:request"""),
            {"request": request["requestId"]},
        )
    delivery = DriveSharingService(
        oauth=SimpleNamespace(lifecycle=SimpleNamespace(db=sharing.db)),
        store=DriveSuggestionStore(db=sharing.db),
        verify_recipient=AsyncMock(),
    )
    return request, review, delivery


async def _paid_request_review(bulk, sharing):
    request = await _request(sharing)
    review = await bulk.create_review(
        user_id="owner",
        search_job_id=_search(bulk, request_id=request["requestId"], count=1),
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request["requestId"],
    )
    with bulk.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET payment_required=TRUE WHERE request_id=:request"),
            {"request": request["requestId"]},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (stripe_mode,request_id,user_id,requester_user_id,status,stripe_payment_intent_id,paid_at)
              VALUES ('test',:request,'owner','recipient','paid',:intent,clock_timestamp())"""),
            {"request": request["requestId"], "intent": f"pi_test_{uuid4().hex}"},
        )
    return request, review


async def _erase_recipient_before_graph_mutation(bulk, monkeypatch, mutate):
    """Prove a real PostgreSQL wait, then commit erasure before the writer."""
    erasure_held = threading.Event()
    release_erasure = threading.Event()
    writer_entered = threading.Event()
    erasure_pid: list[int] = []
    writer_pid: list[int] = []

    def erase(connection):
        lock_connection_graph_users(connection, user_ids=["recipient"])
        erasure_pid.append(connection.execute(text("SELECT pg_backend_pid()")).scalar_one())
        erasure_held.set()
        assert release_erasure.wait(20), "erasure barrier was not released"
        erase_drive_account_in_transaction(connection, user_id="recipient", permanent=False)

    def observe_writer_gate(connection, *, user_ids):
        writer_pid.append(connection.execute(text("SELECT pg_backend_pid()")).scalar_one())
        writer_entered.set()
        lock_connection_graph_users(connection, user_ids=user_ids)

    erasure_task = asyncio.create_task(bulk._transaction(erase))
    writer_task = None
    try:
        assert await asyncio.to_thread(erasure_held.wait, 10)
        monkeypatch.setattr(
            "hushh_mcp.services.connection_graph_service.lock_connection_graph_users",
            observe_writer_gate,
        )
        writer_task = asyncio.create_task(mutate())
        assert await asyncio.to_thread(writer_entered.wait, 10)
        deadline = asyncio.get_running_loop().time() + 1
        while True:
            with bulk.db.engine.connect() as connection:
                blocked = connection.execute(
                    text("SELECT :holder = ANY(pg_blocking_pids(:waiter))"),
                    {"holder": erasure_pid[0], "waiter": writer_pid[0]},
                ).scalar_one()
            if blocked:
                break
            assert asyncio.get_running_loop().time() < deadline, "writer did not wait on erasure"
            await asyncio.sleep(0.01)
    finally:
        release_erasure.set()
        outcomes = await asyncio.wait_for(
            asyncio.gather(
                *([erasure_task, writer_task] if writer_task else [erasure_task]),
                return_exceptions=True,
            ),
            30,
        )
    assert outcomes[0] is None
    return outcomes[1]


@pytest.mark.asyncio
async def test_recipient_erasure_prevents_payment_gated_batch_freeze(
    request_bulk, sharing, monkeypatch
):
    request = await _request(sharing)
    search = _search(request_bulk, request_id=request["requestId"], count=1)
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET payment_required=TRUE WHERE request_id=:request"),
            {"request": request["requestId"]},
        )

    async def freeze():
        return await request_bulk.create_review(
            user_id="owner",
            search_job_id=search,
            client_request_id=str(uuid4()),
            recipients=[_recipient("recipient", "b@example.invalid")],
            excluded=[],
            origin_request_id=request["requestId"],
        )

    outcome = await _erase_recipient_before_graph_mutation(request_bulk, monkeypatch, freeze)
    assert isinstance(outcome, DriveSharingError) and str(outcome) == "request_changed"
    with request_bulk.db.engine.begin() as connection:
        assert connection.execute(text("SELECT count(*) FROM drive_bulk_shares")).scalar_one() == 0
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_files")).scalar_one()
            == 0
        )
        assert (
            connection.execute(text("SELECT count(*) FROM drive_share_requests")).scalar_one() == 0
        )


@pytest.mark.asyncio
async def test_recipient_erasure_prevents_paid_batch_approval(request_bulk, sharing, monkeypatch):
    request, review = await _paid_request_review(request_bulk, sharing)

    async def approve():
        return await request_bulk.approve(
            user_id="owner",
            share_id=review["shareId"],
            revision=review["revision"],
            review_digest=review["reviewDigest"],
        )

    outcome = await _erase_recipient_before_graph_mutation(request_bulk, monkeypatch, approve)
    assert isinstance(outcome, DriveSharingError) and str(outcome) == "bulk_not_found"
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_effects")).scalar_one()
            == 0
        )
        assert connection.execute(text("SELECT count(*) FROM drive_bulk_shares")).scalar_one() == 0
        obligation = (
            connection.execute(
                text("""SELECT status,erased_at,delivery_confirmed_at_erasure
              FROM drive_request_payment_obligations WHERE request_id=:request"""),
                {"request": request["requestId"]},
            )
            .mappings()
            .one()
        )
    assert obligation["status"] == "paid" and obligation["erased_at"] is not None
    assert obligation["delivery_confirmed_at_erasure"] is False


@pytest.mark.asyncio
async def test_recipient_erasure_fences_paid_bulk_effect_settlement(
    request_bulk, sharing, monkeypatch
):
    request, review = await _paid_request_review(request_bulk, sharing)
    await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    job = await request_bulk.claim(
        user_id="owner",
        share_id=review["shareId"],
        position=1,
        recipient_user_id="recipient",
    )
    assert job is not None
    await request_bulk.mark_dispatching(job)

    async def settle():
        return await request_bulk.settle(job, state="succeeded", receipt={"managed": True})

    outcome = await _erase_recipient_before_graph_mutation(request_bulk, monkeypatch, settle)
    assert isinstance(outcome, DriveSharingError) and str(outcome) == "bulk_not_found"
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM drive_share_requests")).scalar_one() == 0
        )
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_effects")).scalar_one()
            == 0
        )
        obligation = (
            connection.execute(
                text("""SELECT status,erased_at,delivery_unsettled_at_erasure,reconciliation_required
              FROM drive_request_payment_obligations WHERE request_id=:request"""),
                {"request": request["requestId"]},
            )
            .mappings()
            .one()
        )
        refunds = _claim_refunds(
            DriveRequestPaymentService(db=request_bulk.db), connection, limit=1
        )
        refund_status = connection.execute(
            text("SELECT status FROM drive_request_payment_refunds WHERE request_id=:request"),
            {"request": request["requestId"]},
        ).scalar_one()
    assert obligation["status"] == "paid" and obligation["erased_at"] is not None
    assert obligation["delivery_unsettled_at_erasure"] is True
    assert obligation["reconciliation_required"] is True
    assert refunds == [] and refund_status == "manual_review"


async def _erase_paid_pending_progressive_batch(request_bulk, sharing, monkeypatch, *, uncertain):
    monkeypatch.setenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", "true")
    request = await _request(sharing)
    request_id = request["requestId"]
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=_search(request_bulk, request_id=request_id, count=4),
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request_id,
        selected_positions=[1, 2, 3],
    )
    await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_request_payment_orders SET
              status='paid',stripe_payment_intent_id=:intent,paid_at=clock_timestamp()
              WHERE request_id=:request"""),
            {"request": request_id, "intent": f"pi_test_{uuid4().hex}"},
        )
        connection.execute(
            text("""UPDATE drive_bulk_share_effects SET state=CASE
              WHEN position=1 THEN 'succeeded'
              WHEN position=2 AND :uncertain THEN 'unknown'
              ELSE 'skipped' END
              WHERE share_id=:share"""),
            {"share": review["shareId"], "uncertain": uncertain},
        )
        if not uncertain:
            request_bulk._finalize(connection, review["shareId"])
        status = connection.execute(
            text("SELECT status FROM drive_share_requests WHERE request_id=:request"),
            {"request": request_id},
        ).scalar_one()
        assert status == "pending"  # A fourth search result still awaits review.
    with request_bulk.db.engine.begin() as connection:
        lock_connection_graph_users(connection, user_ids=["recipient"])
        erase_drive_account_in_transaction(connection, user_id="recipient", permanent=False)
    with request_bulk.db.engine.begin() as connection:
        payout = (
            connection.execute(
                text("SELECT * FROM drive_request_owner_payouts WHERE request_id=:request"),
                {"request": request_id},
            )
            .mappings()
            .one()
        )
        obligation = (
            connection.execute(
                text("SELECT * FROM drive_request_payment_obligations WHERE request_id=:request"),
                {"request": request_id},
            )
            .mappings()
            .one()
        )
        refunds = _claim_refunds(
            DriveRequestPaymentService(db=request_bulk.db), connection, limit=1
        )
    return payout, obligation, refunds


@pytest.mark.asyncio
async def test_erasure_prorates_settled_progressive_batch_while_request_pending(
    request_bulk, sharing, monkeypatch
):
    payout, obligation, refunds = await _erase_paid_pending_progressive_batch(
        request_bulk, sharing, monkeypatch, uncertain=False
    )
    assert payout["expected_files"] == 3
    assert payout["confirmed_files"] == 1
    assert payout["retained_amount_cents"] == 333
    assert payout["refund_amount_cents"] == 667
    assert payout["status"] == "awaiting_refund"
    assert payout["eligible_at_erasure"] is True
    assert obligation["delivery_confirmed_at_erasure"] is True
    assert obligation["delivery_unsettled_at_erasure"] is False
    assert len(refunds) == 1 and refunds[0]["amount_cents"] == 667


@pytest.mark.asyncio
async def test_erasure_holds_progressive_batch_with_unknown_delivery(
    request_bulk, sharing, monkeypatch
):
    payout, obligation, refunds = await _erase_paid_pending_progressive_batch(
        request_bulk, sharing, monkeypatch, uncertain=True
    )
    assert payout["finalized_at"] is None
    assert payout["eligible_at_erasure"] is False
    assert payout["status"] == "manual_review"
    assert obligation["delivery_confirmed_at_erasure"] is True
    assert obligation["delivery_unsettled_at_erasure"] is True
    assert refunds == []


@pytest.mark.asyncio
async def test_request_review_requires_explicit_drive_shareability(request_bulk, sharing):
    request = await _request(sharing)
    search = _search(
        request_bulk,
        request_id=request["requestId"],
        count=3,
        shareability={2: False, 3: None},
    )
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request["requestId"],
    )
    assert review["fileCount"] == 1
    page = await request_bulk.files(user_id="owner", share_id=review["shareId"])
    assert [item["position"] for item in page["files"]] == [1]
    await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    with request_bulk.db.engine.begin() as connection:
        queued = (
            connection.execute(
                text("SELECT position FROM drive_bulk_share_effects WHERE share_id=:share"),
                {"share": review["shareId"]},
            )
            .scalars()
            .all()
        )
    assert queued == [1]


@pytest.mark.asyncio
async def test_only_the_owner_review_counts_matches_only_their_owners_can_share(
    request_bulk, sharing
):
    """A's automatic sheet explains the matches A cannot share; B never learns of them.

    They are usually other people's files in A's Drive (2026-10-18 owner test).
    """
    created = await _request(sharing)
    request_id = created["requestId"]
    await sharing.allow_request(
        user_id="owner", request_id=request_id, revision=created["revision"], amount_cents=1000
    )
    today = datetime.now(UTC).date()
    search = _search(
        request_bulk,
        request_id=request_id,
        count=3,
        shareability={2: False, 3: False},
        selection={
            # The autoshare date selection create_for_request froze.
            "request_selection_version": 2,
            "request_time_intent": "document_coverage",
            "request_owner_review_required": False,
            "request_selection_policy": "title_then_created_then_modified_v1",
            "authority_mode": "trusted_auto",
            "agent_package_required": False,
            "requested_period": {
                "start": (today - timedelta(days=90)).isoformat(),
                "end": today.isoformat(),
                "timezone": "UTC",
            },
        },
    )
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_owner_search_jobs SET status='running' WHERE job_id=:job"),
            {"job": search},
        )
    service = DriveSharingService(
        oauth=SimpleNamespace(lifecycle=SimpleNamespace(db=sharing.db)),
        store=DriveSuggestionStore(db=sharing.db),
        verify_recipient=AsyncMock(),
    )
    bulk = DriveRequestBulkService(
        sharing=sharing,
        search=SimpleNamespace(store=DriveOwnerSearchStore(db=sharing.db)),
        bulk=request_bulk,
        require_owner=AsyncMock(),
        wake=AsyncMock(),
    )

    async def requester_views():
        return [
            await service.status(user_id="recipient", request_id=request_id),
            await service.delivery(user_id="recipient", request_id=request_id, views=True),
            await service.list_requests(user_id="recipient", direction="outgoing"),
        ]

    before = await requester_views()
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_owner_search_jobs SET unshareable_count=2 WHERE job_id=:job"),
            {"job": search},
        )
    after = await requester_views()
    assert after == before
    assert "unshareable" not in json.dumps(after, default=str).casefold()
    with pytest.raises(DriveSharingError, match="request_unavailable"):
        await bulk.review_context(user_id="recipient", request_id=request_id)

    # GET /requests/{id}/review merges the owner's search context.
    review = await service.review(user_id="owner", request_id=request_id)
    assert (review["durableAvailable"], review["trustedAuto"], review["autoshare"]) == (
        True,
        True,
        True,
    )
    review.update(await bulk.review_context(user_id="owner", request_id=request_id))
    assert (review["search"]["matched"], review["search"]["unshareableCount"]) == (3, 2)


@pytest.mark.asyncio
async def test_legacy_frozen_request_review_cannot_queue_drive_grants(request_bulk, sharing):
    request = await _request(sharing)
    search = _search(request_bulk, request_id=request["requestId"], count=1, verified=False)
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request["requestId"],
    )
    with pytest.raises(DriveSharingError, match="search_incomplete"):
        await request_bulk.approve(
            user_id="owner",
            share_id=review["shareId"],
            revision=review["revision"],
            review_digest=review["reviewDigest"],
        )
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_bulk_share_effects WHERE share_id=:share"),
                {"share": review["shareId"]},
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                text("SELECT status FROM drive_bulk_shares WHERE share_id=:share"),
                {"share": review["shareId"]},
            ).scalar_one()
            == "review_ready"
        )
        assert (
            connection.execute(
                text("SELECT status FROM drive_share_requests WHERE request_id=:request"),
                {"request": request["requestId"]},
            ).scalar_one()
            == "pending"
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("history", ["legacy", "current", "frozen", "paid", "completed"])
async def test_request_start_replans_only_unfrozen_pending_legacy_search(
    request_bulk, sharing, history
):
    request = await _trusted_request(sharing)
    request_id = request["requestId"]
    old_job = _search(
        request_bulk,
        request_id=request_id,
        count=1,
        selection=FILE_ACTIVITY_SELECTION if history == "current" else None,
    )
    if history in {"frozen", "paid"}:
        await request_bulk.create_review(
            user_id="owner",
            search_job_id=old_job,
            client_request_id=str(uuid4()),
            recipients=[_recipient("trusted-member", "trusted@example.invalid")],
            excluded=[],
            origin_request_id=request_id,
            selected_positions=[1],
        )
    with request_bulk.db.engine.begin() as connection:
        if history == "paid":
            connection.execute(
                text("""INSERT INTO drive_request_payment_orders
                (stripe_mode,request_id,user_id,requester_user_id,status,paid_at)
                VALUES ('test',:request,'owner','trusted-member','paid',clock_timestamp())"""),
                {"request": request_id},
            )
        if history == "completed":
            connection.execute(
                text(
                    "UPDATE drive_share_requests SET status='completed' WHERE request_id=:request"
                ),
                {"request": request_id},
            )
    planner = AsyncMock(
        return_value={
            "mode": "find",
            "terms": ["standup"],
            "file_kind": "document",
            "time_intent": "document_coverage",
            "subject_scope": "specific_records",
            "subject_complete": True,
        }
    )
    search = SimpleNamespace(
        store=DriveOwnerSearchStore(db=sharing.db),
        create_for_request=AsyncMock(return_value={"jobId": "replacement", "status": "queued"}),
    )
    service = DriveRequestBulkService(
        sharing=sharing,
        search=search,
        bulk=request_bulk,
        planner=planner,
        require_owner=AsyncMock(),
        wake=AsyncMock(),
    )
    result = await service.start_search(user_id="owner", request_id=request_id)
    if history == "legacy":
        assert result["jobId"] == "replacement"
        planner.assert_awaited_once()
        search.create_for_request.assert_awaited_once()
        assert (
            search.create_for_request.await_args.kwargs["plan"]["time_intent"]
            == "document_coverage"
        )
    else:
        assert result["jobId"] == old_job
        planner.assert_not_awaited()
        search.create_for_request.assert_not_awaited()
    with request_bulk.db.engine.begin() as connection:
        assert connection.execute(
            text("SELECT count(*) FROM drive_owner_search_jobs WHERE job_id=:job"),
            {"job": old_job},
        ).scalar_one() == (0 if history == "legacy" else 1)
        if history == "paid":
            assert (
                connection.execute(
                    text(
                        "SELECT status FROM drive_request_payment_orders WHERE request_id=:request"
                    ),
                    {"request": request_id},
                ).scalar_one()
                == "paid"
            )


@pytest.mark.asyncio
@pytest.mark.parametrize("history", ["legacy", "marked_v1", "current", "frozen"])
async def test_statement_replan_preserves_existing_worker_lane(request_bulk, sharing, history):
    request = await sharing.create_request(
        recipient=VerifiedGoogleRecipient(
            "trusted-member",
            "subject-trusted-member",
            "trusted@example.invalid",
            datetime.now(UTC),
            "verified_email",
        ),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        expected_quote_version=1,
        purpose=ShareRequestPurpose(
            purpose="I need Manish's Schwab brokerage statements from 2026",
            periodStart="2026-09-01",
            periodEnd="2026-10-09",
        ),
    )
    request_id = request["requestId"]
    # This job models a request created before the restored demo policy.
    # New requests retain their Gemini-authored plan and must not replan.
    with sharing.db.engine.begin() as connection:
        row = request_bulk._row(
            connection,
            "SELECT * FROM drive_share_requests WHERE request_id=:request",
            {"request": request_id},
        )
        private = sharing._open_request(row)
        private.pop("legacy_request_policy", None)
        connection.execute(
            text(
                "UPDATE drive_share_requests SET request_envelope=CAST(:envelope AS jsonb) "
                "WHERE request_id=:request"
            ),
            {
                "request": request_id,
                "envelope": request_bulk._seal(
                    private, user_id="owner", resource_id=request_id, purpose="request"
                ),
            },
        )
    context = await sharing.request_bulk_context(user_id="owner", request_id=request_id)
    # A real legacy checkpoint contains its original provider query. Omitting
    # arguments altogether describes a malformed job, which must not replan.
    selection = {"arguments": {"query": "name contains 'statement'"}}
    if history == "current":
        plan = _deterministic_statement_plan(context["purpose"])
        queries, period = compile_request_queries(
            plan.model_dump(mode="json"),
            context["purpose"],
            context.get("requestTimeZone") or "UTC",
            requested_at=context["requestCreatedAt"],
        )
        selection = {
            "request_coverage_query_version": 1,
            "queries": queries,
            "requested_period": period,
            "request_subject_terms": plan.terms,
            "request_time_intent": "document_coverage",
            "request_owner_review_required": True,
        }
    old_job = _search(request_bulk, request_id=request_id, count=1, selection=selection)
    if history == "marked_v1":
        with sharing.db.engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE drive_owner_search_jobs SET v1_statement_search=TRUE WHERE job_id=:job"
                ),
                {"job": old_job},
            )
    if history == "frozen":
        await request_bulk.create_review(
            user_id="owner",
            search_job_id=old_job,
            client_request_id=str(uuid4()),
            recipients=[_recipient("trusted-member", "trusted@example.invalid")],
            excluded=[],
            origin_request_id=request_id,
            selected_positions=[1],
        )
    context = await sharing.request_bulk_context(user_id="owner", request_id=request_id)
    store = DriveOwnerSearchStore(db=sharing.db)
    _, changed, worker_stage = await DriveOwnerSearchService(
        store=store
    ).replan_legacy_statement_request(user_id="owner", request_id=request_id, context=context)
    assert changed is (history in {"legacy", "marked_v1"})
    assert worker_stage == ("v1" if history == "marked_v1" else "suggestions")
    with sharing.db.engine.begin() as connection:
        marked = connection.execute(
            text("SELECT v1_statement_search FROM drive_owner_search_jobs WHERE job_id=:job"),
            {"job": old_job},
        ).scalar_one()
    assert marked is (history == "marked_v1")
    due = await store.due(v1_only=True)
    assert [str(row["job_id"]) for row in due] == ([old_job] if history == "marked_v1" else [])


@pytest.mark.asyncio
@pytest.mark.parametrize("verified", [False, True])
async def test_legacy_request_search_refresh_is_idempotent_and_preserves_review(
    request_bulk, sharing, verified
):
    store = DriveOwnerSearchStore(db=request_bulk.db)
    request = await _request(sharing)
    old_job = _search(request_bulk, request_id=request["requestId"], count=2, verified=verified)
    old_status = await store.by_client(user_id="owner", client_request_id=request["requestId"])
    assert old_status["coverage"]["shareabilityVerified"] is verified
    assert old_status["coverage"]["ownerReviewRequired"] is True
    assert await store.clear_legacy_completed_request(
        user_id="owner", request_id=request["requestId"]
    )
    assert not await store.clear_legacy_completed_request(
        user_id="owner", request_id=request["requestId"]
    )
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_owner_search_jobs WHERE job_id=:job"),
                {"job": old_job},
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_owner_search_results WHERE job_id=:job"),
                {"job": old_job},
            ).scalar_one()
            == 0
        )

    current_job = _search(
        request_bulk,
        request_id=request["requestId"],
        count=1,
        verified=True,
        selection=FILE_ACTIVITY_SELECTION,
    )
    assert not await store.clear_legacy_completed_request(
        user_id="owner", request_id=request["requestId"]
    )
    current_status = await store.by_client(user_id="owner", client_request_id=request["requestId"])
    assert current_status["jobId"] == current_job
    assert current_status["coverage"]["shareabilityVerified"] is True

    approved_request = await _request(sharing)
    approved_job = _search(request_bulk, request_id=approved_request["requestId"], count=1)
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=approved_job,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=approved_request["requestId"],
    )
    await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_owner_search_jobs SET checkpoint_envelope=CAST(:envelope AS jsonb)
            WHERE job_id=:job"""),
            {
                "job": approved_job,
                "envelope": request_bulk._seal(
                    {
                        "done": True,
                        "request_origin_id": approved_request["requestId"],
                        "request_revision": approved_request["revision"],
                    },
                    user_id="owner",
                    resource_id=approved_job,
                    purpose="owner-search-checkpoint",
                ),
            },
        )
    assert not await store.clear_legacy_completed_request(
        user_id="owner", request_id=approved_request["requestId"]
    )
    approved_status = await store.by_client(
        user_id="owner", client_request_id=approved_request["requestId"]
    )
    assert approved_status["jobId"] == approved_job
    assert approved_status["coverage"]["shareabilityVerified"] is False


@pytest.mark.asyncio
async def test_failed_request_replan_keeps_prior_terminal_job(request_bulk, sharing, monkeypatch):
    request = await _request(sharing)
    request_id = request["requestId"]
    prior_job = _search(request_bulk, request_id=request_id, count=1, incomplete=True)
    store = DriveOwnerSearchStore(db=request_bulk.db)

    def fail_compile(*_args, **_kwargs):
        raise DriveReadError("invalid_argument")

    monkeypatch.setattr(
        "hushh_mcp.services.drive_owner_search_service.compile_request_queries",
        fail_compile,
    )
    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace())
    with pytest.raises(DriveReadError, match="invalid_argument"):
        await service.create_for_request(
            user_id="owner",
            request_id=request_id,
            request_revision=request["revision"],
            purpose={
                "purpose": "Standup notes from last 3 months",
                "periodStart": "2026-07-01",
                "periodEnd": "2026-10-01",
            },
            plan={},
            require_current=AsyncMock(),
        )

    saved = await store.by_client(user_id="owner", client_request_id=request_id)
    assert saved["jobId"] == prior_job and saved["status"] == "limited"
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_owner_search_results WHERE job_id=:job"),
                {"job": prior_job},
            ).scalar_one()
            == 1
        )


@pytest.mark.asyncio
async def test_competing_active_job_cannot_erase_terminal_request(
    request_bulk, sharing, monkeypatch
):
    request = await _request(sharing)
    request_id = request["requestId"]
    prior_job = _search(request_bulk, request_id=request_id, count=1, incomplete=True)
    store = DriveOwnerSearchStore(db=request_bulk.db)
    checkpoint = {"arguments": {"orderBy": "modifiedTime desc"}}
    competing, _ = await store.create(
        user_id="owner",
        client_request_id=str(uuid4()),
        request={"query": "Other active search"},
        checkpoint=checkpoint,
        confirmed=True,
    )

    with pytest.raises(DriveReadError, match="search_in_progress"):
        await store.create(
            user_id="owner",
            client_request_id=request_id,
            request={"query": "Standup notes from last 3 months"},
            checkpoint=checkpoint,
            confirmed=True,
            replace_terminal_request=True,
        )

    saved = await store.by_client(user_id="owner", client_request_id=request_id)
    assert saved["jobId"] == prior_job and saved["status"] == "limited"
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_owner_search_results WHERE job_id=:job"),
                {"job": prior_job},
            ).scalar_one()
            == 1
        )

    await store.stop(user_id="owner", job_id=competing["jobId"])
    original_seal = store._seal

    def fail_seal(*_args, **_kwargs):
        raise DriveReadError("invalid_argument")

    monkeypatch.setattr(store, "_seal", fail_seal)
    with pytest.raises(DriveReadError, match="invalid_argument"):
        await store.create(
            user_id="owner",
            client_request_id=request_id,
            request={"query": "Standup notes from last 3 months"},
            checkpoint=checkpoint,
            confirmed=True,
            replace_terminal_request=True,
        )
    monkeypatch.setattr(store, "_seal", original_seal)
    assert (await store.by_client(user_id="owner", client_request_id=request_id))[
        "jobId"
    ] == prior_job

    replacement, created = await store.create(
        user_id="owner",
        client_request_id=request_id,
        request={"query": "Standup notes from last 3 months"},
        checkpoint=checkpoint,
        confirmed=True,
        replace_terminal_request=True,
    )
    assert created is True and replacement["jobId"] != prior_job
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_owner_search_results WHERE job_id=:job"),
                {"job": prior_job},
            ).scalar_one()
            == 0
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "state,reason,can_retry",
    [
        ("skipped", "provider_unavailable", True),
        ("skipped", "source_not_shareable", False),
        ("present_unattributed", "permission_outcome_unknown", False),
    ],
)
async def test_72_selected_files_account_for_the_missing_one_without_leaking_it(
    request_bulk, sharing, state, reason, can_retry
):
    request, review, delivery = await _approved_request(request_bulk, sharing, 72)
    share = review["shareId"]
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_share_effects
        SET state=CASE WHEN position<=62 THEN 'succeeded' WHEN position<=71 THEN 'preexisting' ELSE :state END,
            safe_error_code=CASE WHEN position=72 THEN :reason ELSE NULL END
        WHERE share_id=:share"""),
            {"share": share, "state": state, "reason": reason},
        )
        request_bulk._finalize(connection, share)
    owner = await request_bulk.review(user_id="owner", share_id=share)
    assert owner["status"] == "partial"
    assert owner["counts"]["shared"] == 62 and owner["counts"]["alreadyShared"] == 9
    assert owner["counts"]["total"] == 72 and owner["counts"]["failed"] == 0
    assert (
        sum(
            owner["counts"][key]
            for key in (
                "shared",
                "alreadyShared",
                "skipped",
                "failed",
                "needsReview",
                "unknown",
                "pending",
            )
        )
        == 72
    )
    assert owner["issues"] == [{"reasonCode": reason, "count": 1}]
    assert owner["canRetry"] is can_retry
    # A sees the unavailable original and its exact outcome; B sees only the
    # aggregate explanation and 71 confirmed originals, never its private name.
    owner_page = await request_bulk.files(
        user_id="owner", share_id=share, cursor=request_bulk._cursor("owner", share, 50)
    )
    missing = owner_page["files"][-1]
    assert missing["position"] == 72
    assert missing["outcomes"] == [{"status": state, "reasonCode": reason}]
    received = await delivery.delivery(user_id="recipient", request_id=request["requestId"])
    assert received["bulkStatus"] == "partial"
    assert received["counts"] == owner["counts"]
    assert received["sharedCount"] == 71 and received["issues"] == owner["issues"]
    page = await delivery.delivery_files(
        user_id="recipient",
        request_id=request["requestId"],
        cursor=request_bulk._cursor("recipient", share, 50),
    )
    assert len(page["files"]) == 21 and missing["name"] not in {
        item["name"] for item in page["files"]
    }
    with pytest.raises(DriveSharingError, match="request_unavailable"):
        await delivery.delivery(user_id="trusted-member", request_id=request["requestId"])
    with pytest.raises(DriveSharingError, match="bulk_changed"):
        await request_bulk.retry(
            user_id="owner",
            share_id=share,
            revision=owner["revision"] - 1,
            review_digest=owner["reviewDigest"],
        )
    if not can_retry:
        with pytest.raises(DriveSharingError, match="bulk_changed"):
            await request_bulk.retry(
                user_id="owner",
                share_id=share,
                revision=owner["revision"],
                review_digest=owner["reviewDigest"],
            )
        return
    retried = await request_bulk.retry(
        user_id="owner",
        share_id=share,
        revision=owner["revision"],
        review_digest=owner["reviewDigest"],
    )
    assert retried["reviewDigest"] == owner["reviewDigest"]
    assert retried["counts"]["shared"] == 62 and retried["counts"]["alreadyShared"] == 9
    assert retried["counts"]["pending"] == 1 and retried["counts"]["processed"] == 71
    pending = await delivery.delivery(user_id="recipient", request_id=request["requestId"])
    assert pending["bulkStatus"] == "queued" and pending["counts"]["pending"] == 1
    job = await request_bulk.claim(
        user_id="owner", share_id=share, position=72, recipient_user_id="recipient"
    )
    assert job is not None and job["file"]["name"] == missing["name"]
    await request_bulk.mark_dispatching(job)
    await request_bulk.settle(job, state="succeeded", receipt={"managed": True})
    final = await delivery.delivery(user_id="recipient", request_id=request["requestId"])
    assert final["bulkStatus"] == final["status"] == "completed"
    assert final["sharedCount"] == 72 and final["issues"] == []


@pytest.mark.asyncio
async def test_stop_keeps_inflight_result_and_finishes_origin_request(request_bulk, sharing):
    request, review, delivery = await _approved_request(request_bulk, sharing, 2)
    job = await request_bulk.claim(
        user_id="owner", share_id=review["shareId"], position=1, recipient_user_id="recipient"
    )
    await request_bulk.mark_dispatching(job)
    stopped = await request_bulk.stop(user_id="owner", share_id=review["shareId"])
    assert stopped["counts"]["skipped"] == stopped["counts"]["pending"] == 1
    assert (await sharing.request_status(user_id="owner", request_id=request["requestId"]))[
        "status"
    ] == "approved"
    await request_bulk.settle(job, state="succeeded", receipt={"managed": True})
    final = await delivery.delivery(user_id="recipient", request_id=request["requestId"])
    assert final["status"] == "partial" and final["bulkStatus"] == "stopped"
    assert final["counts"]["shared"] == final["counts"]["skipped"] == 1
    assert final["counts"]["pending"] == 0
    assert final["issues"] == [{"reasonCode": "stopped", "count": 1}]


@pytest.mark.asyncio
async def test_request_freezes_all_525_matches_for_only_b(request_bulk, sharing):
    request = await _request(sharing)
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (stripe_mode,request_id,user_id,requester_user_id,status,paid_at)
              VALUES ('test',:request,'owner','recipient','paid',clock_timestamp())"""),
            {"request": request["requestId"]},
        )
    search = await _complete_shared_drive_search(
        request_bulk, sharing, request_id=request["requestId"]
    )
    search_status = await DriveOwnerSearchStore(db=request_bulk.db).status(
        user_id="owner", job_id=search
    )
    assert search_status["coverage"]["shareabilityVerified"] is True
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request["requestId"],
        excluded_positions=[],
    )
    assert review["fileCount"] == 525
    assert review["recipientCount"] == 1
    assert review["counts"]["total"] == 525
    with request_bulk.db.engine.begin() as connection:
        recipients = (
            connection.execute(text("SELECT recipient_user_id FROM drive_bulk_share_recipients"))
            .scalars()
            .all()
        )
        frozen = connection.execute(
            text("SELECT count(*) FROM drive_bulk_share_files WHERE share_id=:share"),
            {"share": review["shareId"]},
        ).scalar_one()
    assert recipients == ["recipient"]
    assert frozen == 525
    projection = DriveSuggestionStore(db=sharing.db)
    delivery = DriveSharingService(
        oauth=SimpleNamespace(lifecycle=SimpleNamespace(db=sharing.db)),
        store=projection,
        verify_recipient=AsyncMock(),
    )
    private_review = await delivery.delivery(user_id="recipient", request_id=request["requestId"])
    assert "bulkShareId" not in private_review
    assert "fileCount" not in private_review
    assert private_review["files"] == []

    approved = await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    assert approved["counts"]["pending"] == 525
    with request_bulk.db.engine.begin() as connection:
        effects = connection.execute(
            text("""SELECT recipient_user_id,count(*) FROM drive_bulk_share_effects
            GROUP BY recipient_user_id""")
        ).all()
    assert effects == [("recipient", 525)]
    before = await delivery.delivery(user_id="recipient", request_id=request["requestId"])
    assert before["bulkShareId"] == review["shareId"]
    assert before["fileCount"] == 525 and before["sharedCount"] == 0
    assert before["files"] == []
    with pytest.raises(DriveSharingError, match="request_unavailable"):
        await delivery.delivery(user_id="trusted-member", request_id=request["requestId"])

    # Synthetic confirmed effects exercise the request/feed and recipient
    # projections without 525 external Google permission calls.
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_share_effects SET state='succeeded',
                updated_at=clock_timestamp() WHERE share_id=:share"""),
            {"share": review["shareId"]},
        )
        request_bulk._finalize(connection, review["shareId"])
    owner_status = await sharing.request_status(user_id="owner", request_id=request["requestId"])
    recipient_status = await sharing.request_status(
        user_id="recipient", request_id=request["requestId"]
    )
    assert owner_status["status"] == recipient_status["status"] == "completed"
    outcome = await delivery.delivery(user_id="recipient", request_id=request["requestId"])
    assert outcome["fileCount"] == outcome["sharedCount"] == 525
    assert outcome["sharingStatus"] == "completed"
    cursor, names = None, []
    while True:
        page = await delivery.delivery_files(
            user_id="recipient", request_id=request["requestId"], cursor=cursor
        )
        assert len(page["files"]) <= 25
        names.extend(file["name"] for file in page["files"])
        cursor = page["nextCursor"]
        if cursor is None:
            break
    assert len(names) == 525
    assert "Hushh Team Standup Notes" in names
    with pytest.raises(DriveSharingError, match="request_unavailable"):
        await delivery.delivery_files(user_id="trusted-member", request_id=request["requestId"])
    with request_bulk.db.engine.begin() as connection:
        events = connection.execute(
            text("""SELECT user_id,event_type FROM drive_share_events
            WHERE request_id=:request AND event_type IN
              ('document_share_decided','document_share_outcome')
            ORDER BY event_type"""),
            {"request": request["requestId"]},
        ).all()
    assert set(events) == {
        ("recipient", "document_share_decided"),
        ("recipient", "document_share_outcome"),
        ("owner", "document_share_outcome"),
    }


@pytest.mark.asyncio
async def test_progressive_batch_claims_keep_search_running_and_aggregate_delivery(
    request_bulk, sharing
):
    request = await _request(sharing)
    request_id = request["requestId"]
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (stripe_mode,request_id,user_id,requester_user_id,status,paid_at)
              VALUES ('test',:request,'owner','recipient','paid',clock_timestamp())"""),
            {"request": request_id},
        )
    search = _search(request_bulk, request_id=request_id, count=50)
    with request_bulk.db.engine.begin() as connection:
        later = [
            {**dict(row), "metadata_envelope": json.dumps(row["metadata_envelope"])}
            for row in connection.execute(
                text("""
            DELETE FROM drive_owner_search_results WHERE job_id=:job AND position>25
            RETURNING position,file_digest,metadata_envelope"""),
                {"job": search},
            ).mappings()
        ]
        connection.execute(
            text("""UPDATE drive_owner_search_jobs
            SET status='queued',matched=25 WHERE job_id=:job"""),
            {"job": search},
        )

    async def prepare_first():
        return await request_bulk.create_review(
            user_id="owner",
            search_job_id=search,
            client_request_id=str(uuid4()),
            recipients=[_recipient("recipient", "b@example.invalid")],
            excluded=[],
            origin_request_id=request_id,
            selected_positions=list(range(1, 26)),
        )

    first, duplicate = await asyncio.gather(prepare_first(), prepare_first())
    assert first["positions"] == list(range(1, 26))
    assert duplicate["shareId"] == first["shareId"]
    assert await request_bulk.pending_request_reviews(user_id="owner", request_id=request_id) == [
        {
            "shareId": first["shareId"],
            "revision": first["revision"],
            "reviewDigest": first["reviewDigest"],
        }
    ]
    await request_bulk.approve(
        user_id="owner",
        share_id=first["shareId"],
        revision=first["revision"],
        review_digest=first["reviewDigest"],
    )
    assert (await sharing.request_status(user_id="owner", request_id=request_id))[
        "status"
    ] == "pending"
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_share_events
            WHERE request_id=:request AND event_type='document_share_decided'"""),
                {"request": request_id},
            ).scalar_one()
            == 0
        )
        connection.execute(
            text("""UPDATE drive_bulk_share_effects
            SET state='succeeded' WHERE share_id=:share"""),
            {"share": first["shareId"]},
        )
        request_bulk._finalize(connection, first["shareId"])
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_share_events
            WHERE request_id=:request AND user_id='recipient'
              AND event_type='document_share_decided'"""),
                {"request": request_id},
            ).scalar_one()
            == 1
        )
    delivery = DriveSharingService(
        oauth=SimpleNamespace(lifecycle=SimpleNamespace(db=sharing.db)),
        store=DriveSuggestionStore(db=sharing.db),
        verify_recipient=AsyncMock(),
    )
    pending_delivery = await delivery.delivery(user_id="recipient", request_id=request_id)
    assert pending_delivery["status"] == "pending"
    assert pending_delivery["batchCount"] == 1
    assert pending_delivery["fileCount"] == pending_delivery["sharedCount"] == 25
    pending_page = await delivery.delivery_files(user_id="recipient", request_id=request_id)
    assert pending_page["nextCursor"] is None
    assert {file["openUrl"] for file in pending_page["files"]} == {
        f"https://drive.google.com/file/d/standup-file-{position}/view" for position in range(1, 26)
    }
    with request_bulk.db.engine.begin() as connection:
        first_row = request_bulk._row(
            connection,
            "SELECT * FROM drive_bulk_shares WHERE share_id=:share",
            {"share": first["shareId"]},
        )
        assert request_bulk._share_recipient_current(connection, first_row, "owner", "recipient")
        connection.execute(
            text("""INSERT INTO drive_owner_search_results(
            job_id,user_id,position,file_digest,metadata_envelope)
            VALUES(:job,'owner',:position,:file_digest,CAST(:metadata_envelope AS jsonb))"""),
            [{"job": search, **row} for row in later],
        )
        connection.execute(
            text("""UPDATE drive_owner_search_jobs
            SET status='completed',matched=50,revision=revision+1 WHERE job_id=:job"""),
            {"job": search},
        )
    assert await request_bulk.unclaimed_positions(user_id="owner", request_id=request_id) == list(
        range(26, 51)
    )
    second = await request_bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request_id,
        selected_positions=list(range(26, 51)),
    )
    assert second["positions"] == list(range(26, 51))
    with pytest.raises(DriveSharingError, match="bulk_conflict"):
        await request_bulk.create_review(
            user_id="owner",
            search_job_id=search,
            client_request_id=str(uuid4()),
            recipients=[_recipient("recipient", "b@example.invalid")],
            excluded=[],
            origin_request_id=request_id,
            selected_positions=[25, 26],
        )
    await request_bulk.approve(
        user_id="owner",
        share_id=second["shareId"],
        revision=second["revision"],
        review_digest=second["reviewDigest"],
    )
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_share_effects
            SET state='succeeded',updated_at=clock_timestamp()
            WHERE share_id=:share"""),
            {"share": first["shareId"]},
        )
        request_bulk._finalize(connection, first["shareId"])
    assert (await sharing.request_status(user_id="owner", request_id=request_id))[
        "status"
    ] == "pending"
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_share_effects
            SET state='succeeded',updated_at=clock_timestamp()+INTERVAL '1 second'
            WHERE share_id=:share"""),
            {"share": second["shareId"]},
        )
        request_bulk._finalize(connection, second["shareId"])
    assert (await sharing.request_status(user_id="owner", request_id=request_id))[
        "status"
    ] == "completed"
    summary = await delivery.delivery(user_id="recipient", request_id=request_id)
    assert summary["fileCount"] == summary["sharedCount"] == 50
    first_page = await delivery.delivery_files(user_id="recipient", request_id=request_id)
    second_page = await delivery.delivery_files(
        user_id="recipient", request_id=request_id, cursor=first_page["nextCursor"]
    )
    assert len(first_page["files"]) == len(second_page["files"]) == 25
    assert second_page["nextCursor"] is None
    assert len({item["name"] for item in first_page["files"] + second_page["files"]}) == 50


@pytest.mark.asyncio
async def test_progressive_600_files_emit_one_confirmed_availability_event(request_bulk, sharing):
    request = await _request(sharing)
    request_id = request["requestId"]
    search = _search(request_bulk, request_id=request_id, count=600)
    for start in range(1, 601, 25):
        review = await request_bulk.create_review(
            user_id="owner",
            search_job_id=search,
            client_request_id=str(uuid4()),
            recipients=[_recipient("recipient", "b@example.invalid")],
            excluded=[],
            origin_request_id=request_id,
            selected_positions=list(range(start, start + 25)),
        )
        await request_bulk.approve(
            user_id="owner",
            share_id=review["shareId"],
            revision=review["revision"],
            review_digest=review["reviewDigest"],
        )
        with request_bulk.db.engine.begin() as connection:
            connection.execute(
                text("""UPDATE drive_bulk_share_effects
                SET state='succeeded' WHERE share_id=:share"""),
                {"share": review["shareId"]},
            )
            request_bulk._finalize(connection, review["shareId"])
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_bulk_share_notifications n
            JOIN drive_bulk_shares b ON b.share_id=n.share_id
            WHERE b.origin_request_id=:request"""),
                {"request": request_id},
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_share_events
            WHERE request_id=:request AND user_id='recipient'
              AND event_type='document_share_decided'"""),
                {"request": request_id},
            ).scalar_one()
            == 1
        )
    assert (await sharing.request_status(user_id="owner", request_id=request_id))[
        "status"
    ] == "completed"


@pytest.mark.asyncio
async def test_progressive_failed_batch_never_claims_files_available(request_bulk, sharing):
    request = await _request(sharing)
    request_id = request["requestId"]
    search = _search(request_bulk, request_id=request_id, count=1)
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request_id,
        selected_positions=[1],
    )
    await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    with request_bulk.db.engine.begin() as connection:
        # A Google failure needs a dispatched grant, which needs a paid order.
        connection.execute(
            text("""UPDATE drive_request_payment_orders
            SET status='paid',paid_at=clock_timestamp() WHERE request_id=:request"""),
            {"request": request_id},
        )
        connection.execute(
            text("""UPDATE drive_bulk_share_effects
            SET state='failed' WHERE share_id=:share"""),
            {"share": review["shareId"]},
        )
        request_bulk._finalize(connection, review["shareId"])
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_share_events
            WHERE request_id=:request AND event_type='document_share_decided'"""),
                {"request": request_id},
            ).scalar_one()
            == 0
        )
    assert (await sharing.request_status(user_id="owner", request_id=request_id))[
        "status"
    ] == "partial"


@pytest.mark.asyncio
@pytest.mark.parametrize("blocker", ["membership", "manual_takeover"])
async def test_manual_approval_after_trusted_authority_changes_can_grant(
    request_bulk, sharing, blocker
):
    review = await _trusted_review(request_bulk, sharing)
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_live_preferences(
              user_id,connection_generation,background_enabled)
              VALUES('owner',1,TRUE)
              ON CONFLICT(user_id) DO UPDATE SET background_enabled=TRUE""")
        )
        if blocker == "membership":
            connection.execute(
                text("""UPDATE one_location_circle_memberships SET status='removed'
                WHERE user_id='trusted-member'""")
            )
        else:
            connection.execute(
                text("""UPDATE drive_share_requests SET
                preparation_error_code='manual_search_active'
                WHERE request_id=(SELECT origin_request_id FROM drive_bulk_shares
                  WHERE share_id=:share)"""),
                {"share": review["shareId"]},
            )
    with pytest.raises(DriveSharingError, match="trusted_request_unavailable"):
        await request_bulk.approve(
            user_id="owner",
            share_id=review["shareId"],
            revision=review["revision"],
            review_digest=review["reviewDigest"],
            approval_source="trusted_auto",
        )
    await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    with request_bulk.db.engine.begin() as connection:
        row = request_bulk._row(
            connection,
            "SELECT * FROM drive_bulk_shares WHERE share_id=:share",
            {"share": review["shareId"]},
        )
        assert row["approval_source"] == "owner"
        assert request_bulk._share_recipient_current(connection, row, "owner", "trusted-member")
    # The actual effect claim uses the same gate immediately before a Google POST.
    assert (
        await request_bulk.claim(
            user_id="owner",
            share_id=review["shareId"],
            position=1,
            recipient_user_id="trusted-member",
        )
        is not None
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "revocation",
    [
        "membership",
        "background",
        "manual_takeover",
        "document_coverage",
        "legacy",
        "request_mismatch",
    ],
)
async def test_auto_approved_batch_stops_after_authority_revoked(request_bulk, sharing, revocation):
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_live_preferences(
              user_id,connection_generation,background_enabled)
              VALUES('owner',1,TRUE)
              ON CONFLICT(user_id) DO UPDATE SET background_enabled=TRUE""")
        )
    review = await _trusted_review(request_bulk, sharing)
    await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
        approval_source="trusted_auto",
    )
    with request_bulk.db.engine.begin() as connection:
        row = request_bulk._row(
            connection,
            "SELECT * FROM drive_bulk_shares WHERE share_id=:share",
            {"share": review["shareId"]},
        )
        assert row["approval_source"] == "trusted_auto"
        assert request_bulk._share_recipient_current(connection, row, "owner", "trusted-member")
        if revocation == "membership":
            connection.execute(
                text("""UPDATE one_location_circle_memberships SET status='removed'
                WHERE user_id='trusted-member'""")
            )
        elif revocation == "background":
            connection.execute(
                text("""UPDATE drive_live_preferences SET background_enabled=FALSE
                WHERE user_id='owner'""")
            )
        elif revocation in {"document_coverage", "legacy", "request_mismatch"}:
            search_id = str(row["search_job_id"])
            envelope = connection.execute(
                text("SELECT checkpoint_envelope FROM drive_owner_search_jobs WHERE job_id=:job"),
                {"job": search_id},
            ).scalar_one()
            checkpoint = request_bulk._open(
                envelope, user_id="owner", resource_id=search_id, purpose="owner-search-checkpoint"
            )
            if revocation == "legacy":
                checkpoint.pop("request_selection_version")
            elif revocation == "request_mismatch":
                checkpoint["request_origin_id"] = str(uuid4())
            else:
                checkpoint.update(
                    request_time_intent="document_coverage", request_owner_review_required=True
                )
            connection.execute(
                text("""UPDATE drive_owner_search_jobs SET checkpoint_envelope=CAST(:envelope AS jsonb)
                    WHERE job_id=:job"""),
                {
                    "job": search_id,
                    "envelope": request_bulk._seal(
                        checkpoint,
                        user_id="owner",
                        resource_id=search_id,
                        purpose="owner-search-checkpoint",
                    ),
                },
            )
        else:
            connection.execute(
                text("""UPDATE drive_share_requests SET
                preparation_error_code='manual_search_active'
                WHERE request_id=(SELECT origin_request_id FROM drive_bulk_shares
                  WHERE share_id=:share)"""),
                {"share": review["shareId"]},
            )
    assert (
        await request_bulk.claim(
            user_id="owner",
            share_id=review["shareId"],
            position=1,
            recipient_user_id="trusted-member",
        )
        is None
    )
    with request_bulk.db.engine.begin() as connection:
        state = connection.execute(
            text("""SELECT state FROM drive_bulk_share_effects
            WHERE share_id=:share AND position=1"""),
            {"share": review["shareId"]},
        ).scalar_one()
        assert state == "skipped"


@pytest.mark.asyncio
async def test_owner_recovers_only_never_posted_auto_skipped_file(request_bulk, sharing):
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_live_preferences(
              user_id,connection_generation,background_enabled)
              VALUES('owner',1,TRUE)""")
        )
    auto = await _trusted_review(request_bulk, sharing)
    with request_bulk.db.engine.begin() as connection:
        request_id = connection.execute(
            text("SELECT origin_request_id FROM drive_bulk_shares WHERE share_id=:share"),
            {"share": auto["shareId"]},
        ).scalar_one()
        search_id = connection.execute(
            text("SELECT search_job_id FROM drive_bulk_shares WHERE share_id=:share"),
            {"share": auto["shareId"]},
        ).scalar_one()
    await request_bulk.approve(
        user_id="owner",
        share_id=auto["shareId"],
        revision=auto["revision"],
        review_digest=auto["reviewDigest"],
        approval_source="trusted_auto",
    )
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests SET
            preparation_error_code='manual_search_active' WHERE request_id=:request"""),
            {"request": request_id},
        )
    # The grant worker settles this effect before a Google POST. The request
    # remains pending so its owner can review the exact file again.
    assert (
        await request_bulk.claim(
            user_id="owner",
            share_id=auto["shareId"],
            position=1,
            recipient_user_id="trusted-member",
        )
        is None
    )
    assert (await sharing.request_status(user_id="owner", request_id=str(request_id)))[
        "status"
    ] == "pending"
    before = await request_bulk.batches_by_request(user_id="owner", request_id=str(request_id))
    assert before["claimedPositions"] == [1]
    assert before["recoverablePositions"] == [1]
    assert before["aggregateCounts"]["total"] == 1
    assert before["aggregateCounts"]["skipped"] == 1

    owner = await request_bulk.create_review(
        user_id="owner",
        search_job_id=str(search_id),
        client_request_id=str(uuid4()),
        recipients=[_recipient("trusted-member", "trusted@example.invalid")],
        excluded=[],
        origin_request_id=str(request_id),
        selected_positions=[1],
    )
    assert owner["shareId"] != auto["shareId"]
    with request_bulk.db.engine.begin() as connection:
        historical, current = connection.execute(
            text("""SELECT share_id,origin_request_id FROM drive_bulk_share_files
            WHERE share_id IN (:auto,:owner) ORDER BY share_id"""),
            {"auto": auto["shareId"], "owner": owner["shareId"]},
        ).all()
        claims = {str(share): origin for share, origin in (historical, current)}
        assert claims[auto["shareId"]] is None
        assert str(claims[owner["shareId"]]) == str(request_id)
    # UAT replays every migration on each deploy. An old migration must not
    # recreate the one-batch index, and 259 must not reclaim the released file.
    with request_bulk.db.engine.connect() as connection:
        for name in (
            "256_drive_request_bulk_search.sql",
            "259_drive_progressive_request_batches.sql",
        ):
            connection.exec_driver_sql((MIGRATIONS / name).read_text().replace("%", "%%"))
        connection.commit()
        assert (
            connection.execute(
                text("SELECT to_regclass('drive_bulk_origin_request_unique')")
            ).scalar_one()
            is None
        )
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_bulk_shares
            WHERE user_id='owner' AND origin_request_id=:request"""),
                {"request": request_id},
            ).scalar_one()
            == 2
        )
        replayed = connection.execute(
            text("""SELECT share_id,origin_request_id FROM drive_bulk_share_files
            WHERE share_id IN (:auto,:owner)"""),
            {"auto": auto["shareId"], "owner": owner["shareId"]},
        ).all()
        claims = {str(share): origin for share, origin in replayed}
        assert claims[auto["shareId"]] is None
        assert str(claims[owner["shareId"]]) == str(request_id)
    pending = await request_bulk.batches_by_request(user_id="owner", request_id=str(request_id))
    assert pending["claimedPositions"] == [1]
    assert pending["recoverablePositions"] == []
    assert pending["aggregateCounts"]["total"] == 1
    assert pending["aggregateCounts"]["skipped"] == 0
    assert pending["aggregateCounts"]["pending"] == 1

    await request_bulk.approve(
        user_id="owner",
        share_id=owner["shareId"],
        revision=owner["revision"],
        review_digest=owner["reviewDigest"],
    )
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_share_effects SET state='succeeded'
            WHERE share_id=:share"""),
            {"share": owner["shareId"]},
        )
        request_bulk._finalize(connection, owner["shareId"])
    outcome = await request_bulk.batches_by_request(user_id="owner", request_id=str(request_id))
    assert outcome["aggregateCounts"]["total"] == 1
    assert outcome["aggregateCounts"]["shared"] == 1
    assert outcome["aggregateCounts"]["skipped"] == 0
    assert (await sharing.request_status(user_id="owner", request_id=str(request_id)))[
        "status"
    ] == "completed"
    delivery = DriveSharingService(
        oauth=SimpleNamespace(lifecycle=SimpleNamespace(db=sharing.db)),
        store=DriveSuggestionStore(db=sharing.db),
        verify_recipient=AsyncMock(),
    )
    recipient = await delivery.delivery(user_id="trusted-member", request_id=str(request_id))
    assert recipient["fileCount"] == recipient["counts"]["total"] == 1
    assert recipient["sharedCount"] == recipient["counts"]["shared"] == 1
    assert recipient["counts"]["skipped"] == 0
    assert recipient["issues"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("state,attempts", [("skipped", 1), ("unknown", 1)])
async def test_owner_cannot_recover_effect_that_may_have_posted(
    request_bulk, sharing, state, attempts
):
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_live_preferences(
              user_id,connection_generation,background_enabled)
              VALUES('owner',1,TRUE)""")
        )
    review = await _trusted_review(request_bulk, sharing)
    await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
        approval_source="trusted_auto",
    )
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_share_effects SET state=:state,attempts=:attempts,
            safe_error_code='recipient_changed' WHERE share_id=:share"""),
            {"state": state, "attempts": attempts, "share": review["shareId"]},
        )
        connection.execute(
            text("""UPDATE drive_share_requests SET
            preparation_error_code='manual_search_active'
            WHERE request_id=(SELECT origin_request_id FROM drive_bulk_shares
              WHERE share_id=:share)"""),
            {"share": review["shareId"]},
        )
        request_id, search_id = connection.execute(
            text("""SELECT origin_request_id,search_job_id FROM drive_bulk_shares
            WHERE share_id=:share"""),
            {"share": review["shareId"]},
        ).one()
    batches = await request_bulk.batches_by_request(user_id="owner", request_id=str(request_id))
    assert batches["recoverablePositions"] == []
    with pytest.raises(DriveSharingError, match="bulk_conflict"):
        await request_bulk.create_review(
            user_id="owner",
            search_job_id=str(search_id),
            client_request_id=str(uuid4()),
            recipients=[_recipient("trusted-member", "trusted@example.invalid")],
            excluded=[],
            origin_request_id=str(request_id),
            selected_positions=[1],
        )


@pytest.mark.asyncio
async def test_owner_selected_exact_request_keeps_legacy_review_path(request_bulk, sharing):
    request = await sharing.create_request(
        recipient=VerifiedGoogleRecipient(
            "recipient", "1234567", "b@example.invalid", datetime.now(UTC)
        ),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        purpose=ShareRequestPurpose(purpose="One exact file chosen by the owner"),
        owner_initiated=True,
    )
    review = await sharing.owner_review(user_id="owner", request_id=request["requestId"])
    assert review["durableAvailable"] is False
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(
                text(
                    "SELECT bulk_search_started_at FROM drive_share_requests WHERE request_id=:request"
                ),
                {"request": request["requestId"]},
            ).scalar_one()
            is None
        )


@pytest.mark.asyncio
async def test_request_rejects_incomplete_search_and_other_recipient(request_bulk, sharing):
    request = await _request(sharing)
    incomplete = _search(request_bulk, request_id=request["requestId"], count=26, incomplete=True)
    with pytest.raises(DriveSharingError, match="search_incomplete"):
        await request_bulk.create_review(
            user_id="owner",
            search_job_id=incomplete,
            client_request_id=str(uuid4()),
            recipients=[_recipient("recipient", "b@example.invalid")],
            excluded=[],
            origin_request_id=request["requestId"],
            excluded_positions=[],
        )
    with request_bulk.db.engine.begin() as connection:
        assert connection.execute(text("SELECT count(*) FROM drive_bulk_shares")).scalar_one() == 0

    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_owner_search_jobs SET status='completed',
            incomplete_search=false WHERE job_id=:job"""),
            {"job": incomplete},
        )
    with pytest.raises(DriveSharingError):
        await request_bulk.create_review(
            user_id="owner",
            search_job_id=incomplete,
            client_request_id=str(uuid4()),
            recipients=[
                _recipient("recipient", "b@example.invalid"),
                _recipient("trusted-member", "trusted@example.invalid"),
            ],
            excluded=[],
            origin_request_id=request["requestId"],
            excluded_positions=[],
        )
    with request_bulk.db.engine.begin() as connection:
        assert connection.execute(text("SELECT count(*) FROM drive_bulk_shares")).scalar_one() == 0


@pytest.mark.asyncio
async def test_decline_during_provider_page_discards_result_and_blocks_review(
    request_bulk, sharing
):
    request = await _request(sharing)
    context = await sharing.request_bulk_context(
        user_id="owner", request_id=request["requestId"], start=True
    )
    store = DriveOwnerSearchStore(db=request_bulk.db)
    query = {"query": "Standup notes from last 3 months", "timezone": "UTC"}
    arguments = {"query": "name contains 'Standup'", "orderBy": "createdTime desc"}
    state, _ = await store.create(
        user_id="owner",
        client_request_id=request["requestId"],
        request=query,
        confirmed=True,
        checkpoint={
            "request": query,
            "request_origin_id": request["requestId"],
            "request_revision": context["revision"],
            "arguments": arguments,
            "queries": [{"arguments": arguments}],
            "query_index": 0,
            "requested_period": {
                "start": context["purpose"]["periodStart"],
                "end": context["purpose"]["periodEnd"],
                "timezone": "UTC",
            },
            "phase": "user",
            "page_token": None,
            "drive_page_token": None,
            "drives": [],
            "drive_index": 0,
            "seen_tokens": [],
            "drive_tokens": [],
        },
    )
    entered, resume = asyncio.Event(), asyncio.Event()

    async def read(*, user_id, tool_name, arguments):
        assert user_id == "owner" and tool_name == "search_files"
        entered.set()
        await resume.wait()
        return ExternalMcpToolResult(
            False,
            {
                "files": [
                    {
                        "id": "late-result",
                        "title": "Standup notes 2026-09-20",
                        "mimeType": "application/vnd.google-apps.document",
                        "modifiedTime": "2026-09-20T00:00:00Z",
                    }
                ],
                "incompleteSearch": False,
            },
            False,
        )

    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace(read_tool=read))
    task = asyncio.create_task(service.run_one(user_id="owner", job_id=state["jobId"], max_pages=1))
    await asyncio.wait_for(entered.wait(), timeout=3)
    await sharing.decline_or_cancel(
        user_id="owner",
        request_id=request["requestId"],
        revision=context["revision"],
        decision="declined",
    )
    resume.set()
    assert await task == "superseded"
    assert (await store.results(user_id="owner", job_id=state["jobId"]))["files"] == []
    with pytest.raises(DriveSharingError):
        await request_bulk.create_review(
            user_id="owner",
            search_job_id=state["jobId"],
            client_request_id=str(uuid4()),
            recipients=[_recipient("recipient", "b@example.invalid")],
            excluded=[],
            origin_request_id=request["requestId"],
            excluded_positions=[],
        )


@pytest.mark.asyncio
async def test_decline_after_review_blocks_bulk_approval(request_bulk, sharing):
    request = await _request(sharing)
    search = _search(request_bulk, request_id=request["requestId"], count=1)
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request["requestId"],
        excluded_positions=[],
    )
    await sharing.decline_or_cancel(
        user_id="owner",
        request_id=request["requestId"],
        revision=request["revision"],
        decision="declined",
    )
    with pytest.raises(DriveSharingError):
        await request_bulk.approve(
            user_id="owner",
            share_id=review["shareId"],
            revision=review["revision"],
            review_digest=review["reviewDigest"],
        )
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_effects")).scalar_one()
            == 0
        )


def _owner_feed_schema(db):
    """The Feed tables the owner's files-sent card writes, beside this schema."""
    with db.engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS actor_identity_cache(user_id TEXT PRIMARY KEY,display_name TEXT)"
        )
        connection.exec_driver_sql(
            "ALTER TABLE actor_identity_cache ADD COLUMN IF NOT EXISTS email TEXT"
        )
        connection.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS actor_profiles(user_id TEXT PRIMARY KEY)"
        )
        connection.exec_driver_sql(
            "INSERT INTO actor_profiles VALUES ('owner'),('recipient') ON CONFLICT DO NOTHING"
        )
        connection.exec_driver_sql(
            """CREATE TABLE IF NOT EXISTS feed_events(
              id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, source_domain TEXT NOT NULL,
              event_type TEXT NOT NULL, actor_label TEXT,
              metadata JSONB NOT NULL DEFAULT '{}'::jsonb, source_row_id TEXT,
              read_at TIMESTAMPTZ, dismissed_at TIMESTAMPTZ,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now())"""
        )
        connection.exec_driver_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_feed_events_source_projection ON feed_events"
            "(user_id,source_domain,event_type,source_row_id) WHERE source_row_id IS NOT NULL"
        )
        connection.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS feed_event_counterparts("
            "feed_event_id BIGINT PRIMARY KEY REFERENCES feed_events(id) ON DELETE CASCADE,"
            "counterpart_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id))"
        )
        connection.execute(
            text("""INSERT INTO actor_identity_cache(user_id,display_name,email)
            VALUES ('recipient','Ankit','ankit@example.invalid')
            ON CONFLICT (user_id) DO UPDATE SET display_name=EXCLUDED.display_name,
              email=EXCLUDED.email""")
        )


def _files_sent_cards(db, request_id):
    with db.engine.connect() as connection:
        return [
            dict(row)
            for row in connection.execute(
                text("""SELECT f.id,f.user_id,f.actor_label,f.metadata,f.dismissed_at,
                  c.counterpart_user_id
                FROM feed_events f LEFT JOIN feed_event_counterparts c ON c.feed_event_id=f.id
                WHERE f.event_type='document_share_files_sent' AND f.source_row_id=:request"""),
                {"request": request_id},
            ).mappings()
        ]


async def _approved_batch(bulk, *, search, request_id, positions):
    review = await bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request_id,
        selected_positions=positions,
    )
    await bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    return review["shareId"]


def _settle(bulk, share, positions, *, state="succeeded"):
    with bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_share_effects SET state=:state
            WHERE share_id=:share AND position = ANY(:positions)"""),
            {"share": share, "positions": positions, "state": state},
        )
        bulk._finalize(connection, share)


@pytest.mark.asyncio
async def test_owner_gets_one_files_sent_card_per_request_updated_per_batch(request_bulk, sharing):
    _owner_feed_schema(sharing.db)
    request = await _request(sharing)
    request_id = request["requestId"]
    search = _search(request_bulk, request_id=request_id, count=50)
    first = await _approved_batch(
        request_bulk, search=search, request_id=request_id, positions=list(range(1, 26))
    )

    # The first confirmed file creates the card while the batch still runs.
    _settle(request_bulk, first, list(range(1, 11)))
    [card] = _files_sent_cards(sharing.db, request_id)
    assert card["user_id"] == "owner"
    assert card["actor_label"] == "Ankit"
    assert card["counterpart_user_id"] == "recipient"
    # Only a count, the request and the requester's name: never a file name.
    assert card["metadata"] == {
        "request_id": request_id,
        "shared_count": 10,
        "counterpart_label": "Ankit",
    }

    # A finished batch updates the same row; a retried settle adds nothing.
    _settle(request_bulk, first, list(range(1, 26)))
    _settle(request_bulk, first, list(range(1, 26)))
    [card] = _files_sent_cards(sharing.db, request_id)
    assert card["metadata"]["shared_count"] == 25

    # A dismissed card stays dismissed while its count keeps up.
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE feed_events SET dismissed_at=now() WHERE id=:id"), {"id": card["id"]}
        )
    second = await _approved_batch(
        request_bulk, search=search, request_id=request_id, positions=list(range(26, 51))
    )
    # Effect positions are local to each batch: this batch's 1-25 are files 26-50.
    _settle(request_bulk, second, list(range(1, 26)))
    [card] = _files_sent_cards(sharing.db, request_id)
    assert card["metadata"]["shared_count"] == 50
    assert card["dismissed_at"] is not None
    with sharing.db.engine.connect() as connection:
        # The requester never receives this owner card.
        assert (
            connection.execute(
                text("""SELECT count(*) FROM feed_events
                WHERE user_id='recipient' AND event_type='document_share_files_sent'""")
            ).scalar_one()
            == 0
        )


@pytest.mark.asyncio
async def test_failed_batch_creates_no_files_sent_card(request_bulk, sharing):
    _owner_feed_schema(sharing.db)
    request = await _request(sharing)
    request_id = request["requestId"]
    search = _search(request_bulk, request_id=request_id, count=2)
    share = await _approved_batch(
        request_bulk, search=search, request_id=request_id, positions=[1, 2]
    )
    _settle(request_bulk, share, [1, 2], state="failed")
    assert _files_sent_cards(sharing.db, request_id) == []


@pytest.mark.asyncio
async def test_files_sent_card_failure_never_fails_the_share(request_bulk, sharing):
    # No Feed tables in this schema: the card write fails inside its savepoint.
    request = await _request(sharing)
    request_id = request["requestId"]
    search = _search(request_bulk, request_id=request_id, count=1)
    share = await _approved_batch(request_bulk, search=search, request_id=request_id, positions=[1])
    _settle(request_bulk, share, [1])
    with sharing.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_share_events WHERE request_id=:request
                AND user_id='recipient' AND event_type='document_share_decided'"""),
                {"request": request_id},
            ).scalar_one()
            == 1
        )
    assert (await sharing.request_status(user_id="owner", request_id=request_id))[
        "status"
    ] == "completed"


def _grant_with_receipt(bulk, share, position):
    receipt = {
        "managed": True,
        "permission_id": f"permission-{position}",
        "email": "b@example.invalid",
        "issuer": {"subject": "owner-google", "oauthClientId": "synthetic-client"},
        "provenance": "successful_create_after_absence_check",
    }
    with bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_share_effects SET state='succeeded',
              receipt_envelope=CAST(:receipt AS jsonb)
            WHERE share_id=:share AND position=:position"""),
            {
                "share": share,
                "position": position,
                "receipt": bulk._seal(
                    receipt,
                    user_id="owner",
                    resource_id=f"{share}:{position}:recipient",
                    purpose="bulk-share-receipt",
                ),
            },
        )


@pytest.mark.asyncio
async def test_owner_removes_one_file_through_the_durable_removal_queue(request_bulk, sharing):
    from hushh_mcp.services.drive_owner_shared_files import (
        UNDO_SECONDS,
        DriveOwnerSharedFilesStore,
    )
    from hushh_mcp.services.drive_request_bulk_removal_store import DriveRequestBulkRemovalStore

    _owner_feed_schema(sharing.db)
    request = await _request(sharing)
    request_id = request["requestId"]
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (stripe_mode,request_id,user_id,requester_user_id,status,paid_at)
              VALUES ('test',:request,'owner','recipient','paid',clock_timestamp())"""),
            {"request": request_id},
        )
    search = _search(request_bulk, request_id=request_id, count=3)
    share = await _approved_batch(
        request_bulk, search=search, request_id=request_id, positions=[1, 2, 3]
    )
    _grant_with_receipt(request_bulk, share, 1)
    _settle(request_bulk, share, [2])  # Confirmed, but One holds no create receipt.
    _settle(request_bulk, share, [3], state="preexisting")
    store = DriveOwnerSharedFilesStore(db=sharing.db, cipher=request_bulk.cipher)

    listed = await store.shared_files(user_id="owner", request_id=request_id)
    assert listed["sharedCount"] == 3
    assert listed["recipientLabel"] == "Ankit"
    by_ref = {item["fileRef"]: item for item in listed["files"]}
    one, two, three = (f"{share}:{position}" for position in (1, 2, 3))
    assert by_ref[one]["name"].startswith("Standup notes")
    assert (by_ref[one]["status"], by_ref[one]["removable"]) == ("shared", True)
    assert (by_ref[two]["status"], by_ref[two]["removable"]) == ("shared", False)
    assert (by_ref[three]["status"], by_ref[three]["removable"]) == ("had_access", False)

    # The requester (or anyone else) cannot list or remove the owner's files.
    for action in (
        store.shared_files(user_id="recipient", request_id=request_id),
        store.remove_file(user_id="recipient", request_id=request_id, file_ref=one),
        store.restore_file(user_id="recipient", request_id=request_id, file_ref=one),
    ):
        with pytest.raises(DriveSharingError, match="request_unavailable"):
            await action
    # One never deletes a permission it did not create.
    for ref in (two, three):
        with pytest.raises(DriveSharingError, match="no_revocable_permissions"):
            await store.remove_file(user_id="owner", request_id=request_id, file_ref=ref)

    removed = await store.remove_file(user_id="owner", request_id=request_id, file_ref=one)
    again = await store.remove_file(user_id="owner", request_id=request_id, file_ref=one)
    assert (
        removed
        == again
        == {
            "fileRef": one,
            "status": "removing",
            "undoable": True,
            "undoSeconds": UNDO_SECONDS,
        }
    )
    with sharing.db.engine.connect() as connection:
        [row] = connection.execute(
            text("""SELECT *,next_at>clock_timestamp() AS waiting FROM drive_request_bulk_removals
            WHERE request_id=:request"""),
            {"request": request_id},
        ).mappings()
    assert (row["position"], row["state"], row["attempts"], row["waiting"]) == (
        1,
        "queued",
        0,
        True,
    )
    # Queued only: nothing is due until Undo has passed, so no Drive call yet.
    removals = DriveRequestBulkRemovalStore(db=sharing.db, cipher=request_bulk.cipher)
    assert await removals.due(limit=20) == []

    # B's list drops the file immediately; Undo brings it back.
    def recipient_page():
        return request_bulk.recipient_request_files(
            recipient_user_id="recipient",
            recipient_subject="1234567",
            recipient_email="b@example.invalid",
            request_id=request_id,
        )

    recipient = {
        "recipient_user_id": "recipient",
        "recipient_subject": "1234567",
        "recipient_email": "b@example.invalid",
    }

    async def received():
        # Profile "Drive files shared with you": the collection count and its
        # file names and links.
        [collection] = (await request_bulk.inbox(**recipient))["shares"]
        files = await request_bulk.recipient_files(**recipient, share_id=share)
        return (
            collection["sharedCount"],
            files["sharedCount"],
            {item["openUrl"] for item in files["files"]},
        )

    remaining = {
        "https://drive.google.com/file/d/standup-file-2/view",
        "https://drive.google.com/file/d/standup-file-3/view",
    }
    page = await recipient_page()
    assert page["sharedCount"] == 2
    assert {item["openUrl"] for item in page["files"]} == remaining
    assert await received() == (2, 2, remaining)
    assert (await store.restore_file(user_id="owner", request_id=request_id, file_ref=one))[
        "status"
    ] == "shared"
    assert (await recipient_page())["sharedCount"] == 3
    assert await received() == (
        3,
        3,
        remaining | {"https://drive.google.com/file/d/standup-file-1/view"},
    )

    # Once due, the existing worker claims the owner's one-file removal even
    # though the request was never stopped.
    await store.remove_file(user_id="owner", request_id=request_id, file_ref=one)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_request_bulk_removals
            SET next_at=clock_timestamp()-INTERVAL '1 second' WHERE request_id=:request"""),
            {"request": request_id},
        )
    [due] = await removals.due(limit=20)
    job = await removals.claim(user_id="owner", removal_id=str(due["removal_id"]))
    assert job["plan"]["scope"] == "owner_file"
    assert job["plan"]["file_id"] == "standup-file-1"
    assert job["plan"]["permission_id"] == "permission-1"
    # A claimed removal can no longer be undone.
    with pytest.raises(DriveSharingError, match="revocation_pending"):
        await store.restore_file(user_id="owner", request_id=request_id, file_ref=one)
    listed = await store.shared_files(user_id="owner", request_id=request_id)
    assert {item["fileRef"]: item["status"] for item in listed["files"]}[one] == "removing"


@pytest.mark.asyncio
async def test_unscoped_removal_still_requires_a_request_wide_stop(request_bulk, sharing):
    from hushh_mcp.services.drive_request_bulk_removal_store import DriveRequestBulkRemovalStore

    request = await _request(sharing)
    request_id = request["requestId"]
    search = _search(request_bulk, request_id=request_id, count=1)
    share = await _approved_batch(request_bulk, search=search, request_id=request_id, positions=[1])
    _grant_with_receipt(request_bulk, share, 1)
    removals = DriveRequestBulkRemovalStore(db=sharing.db, cipher=request_bulk.cipher)
    removal_id = str(uuid4())
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_request_bulk_removals
              (removal_id,request_id,user_id,share_id,position,recipient_user_id,plan_envelope)
              VALUES (:id,:request,'owner',:share,1,'recipient',CAST(:plan AS jsonb))"""),
            {
                "id": removal_id,
                "request": request_id,
                "share": share,
                "plan": json.dumps(
                    request_bulk.cipher.seal(
                        {"file_id": "standup-file-1"},
                        user_id="owner",
                        resource_id=removal_id,
                        purpose="bulk-removal-plan",
                    )
                ),
            },
        )
    # The owner's Undo cancels only its own one-file removal. A removal a Stop
    # or an access expiry queued is never undoable, even while unclaimed.
    from hushh_mcp.services.drive_owner_shared_files import DriveOwnerSharedFilesStore

    _owner_feed_schema(sharing.db)
    store = DriveOwnerSharedFilesStore(db=sharing.db, cipher=request_bulk.cipher)
    ref = f"{share}:1"
    [listed] = (await store.shared_files(user_id="owner", request_id=request_id))["files"]
    assert (listed["status"], listed["undoable"]) == ("removing", False)
    removed = await store.remove_file(user_id="owner", request_id=request_id, file_ref=ref)
    assert (removed["status"], removed["undoable"]) == ("removing", False)
    with pytest.raises(DriveSharingError, match="revocation_pending"):
        await store.restore_file(user_id="owner", request_id=request_id, file_ref=ref)
    with sharing.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_bulk_removals WHERE removal_id=:id"),
                {"id": removal_id},
            ).scalar_one()
            == 1
        )
    with pytest.raises(DriveSharingError, match="approval_superseded"):
        await removals.claim(user_id="owner", removal_id=removal_id)


async def _owner_approved_unpaid_batch(bulk, sharing, *, count=25):
    """A, outside B's Trusted circle, approves `count` exact files; B has not paid."""
    request_id = (await _request(sharing))["requestId"]
    review = await bulk.create_review(
        user_id="owner",
        search_job_id=_search(bulk, request_id=request_id, count=count),
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request_id,
        selected_positions=list(range(1, count + 1)),
    )
    await bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    return request_id, review["shareId"]


def _grant_worker(bulk):
    """The real grant worker and store; only Google's identity and ACL calls are synthetic."""
    adapter = SimpleNamespace(
        inspect_shareable=AsyncMock(),
        list_permissions=AsyncMock(return_value=PermissionSnapshot(())),
        create_reader=AsyncMock(
            side_effect=lambda **_kwargs: CreatedReader(
                f"permission-{uuid4().hex}", "b@example.invalid"
            )
        ),
    )
    oauth = SimpleNamespace(
        current_credential=AsyncMock(
            return_value=(
                {"connection_generation": 1},
                {
                    "accessToken": "synthetic-token",
                    "subject": "owner-google",
                    "oauthClientId": "synthetic-client",
                },
            )
        )
    )
    worker = DriveBulkShareWorker(
        store=bulk,
        adapter=adapter,
        oauth=oauth,
        verify_recipient=AsyncMock(),
        send_push=lambda *_args, **_kwargs: 1,
        wake=AsyncMock(),
    )
    return worker, adapter


def _count_offers(bulk, monkeypatch):
    """Record how many grants each drain's main queue read offered the worker."""
    offers = []
    due = bulk.due

    async def counted(*args, **kwargs):
        rows = await due(*args, **kwargs)
        if kwargs.get("limit") != 1:  # The worker's follow-up "anything left?" probe.
            offers.append(len(rows))
        return rows

    monkeypatch.setattr(bulk, "due", counted)
    return offers


def _effect_outcomes(db, share_id):
    with db.engine.connect() as connection:
        return {
            (state, code): count
            for state, code, count in connection.execute(
                text("""SELECT state,safe_error_code,count(*) FROM drive_bulk_share_effects
                WHERE share_id=:share GROUP BY state,safe_error_code"""),
                {"share": share_id},
            ).all()
        }


@pytest.mark.asyncio
async def test_unpaid_approved_batch_is_never_offered_until_paid_then_granted(
    request_bulk, sharing, monkeypatch
):
    """13ee925d (UAT, 2026-10-18): A approved 25 files and B had not paid.

    Every sharing drain offered all 25, claim() refused each one with
    payment_required, and nothing moved them: 211+ runs, about 4.5 s each.
    An unpaid grant is not work. It is never offered, and B's payment makes
    it due on the very next drain.
    """
    request_id, share_id = await _owner_approved_unpaid_batch(request_bulk, sharing)
    offers = _count_offers(request_bulk, monkeypatch)
    claims = []
    claim = request_bulk.claim

    async def counted_claim(**kwargs):
        claims.append(kwargs["position"])
        return await claim(**kwargs)

    monkeypatch.setattr(request_bulk, "claim", counted_claim)
    worker, adapter = _grant_worker(request_bulk)

    started = time.perf_counter()
    for _ in range(5):
        assert (await worker.run(max_jobs=400, deadline_seconds=80))["outcomes"] == {}
    # Provider pacing alone cost about 4.5 s per drain for these 25 rows.
    assert time.perf_counter() - started < 2
    assert offers == [0] * 5
    assert claims == []
    assert _effect_outcomes(request_bulk.db, share_id) == {("queued", None): 25}
    adapter.create_reader.assert_not_awaited()

    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_request_payment_orders
            SET status='paid',paid_at=clock_timestamp(),stripe_payment_intent_id='pi_test_lane'
            WHERE request_id=:request"""),
            {"request": request_id},
        )
    worker._pace = AsyncMock()  # Provider pacing is not under test here.
    assert (await worker.run(max_jobs=400, deadline_seconds=80))["outcomes"] == {"succeeded": 25}
    assert offers[-1] == 25
    assert _effect_outcomes(request_bulk.db, share_id) == {("succeeded", None): 25}
    assert adapter.create_reader.await_count == 25


@pytest.mark.asyncio
async def test_dormant_unpaid_share_yields_to_newer_paid_share_without_parallel_grants(
    request_bulk, sharing
):
    older_request, older_share = await _owner_approved_unpaid_batch(request_bulk, sharing)
    assert _effect_outcomes(request_bulk.db, older_share) == {("queued", None): 25}
    # Approval of a second request must not wait for the first buyer's payment.
    newer_request, newer_share = await _owner_approved_unpaid_batch(request_bulk, sharing)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_request_payment_orders
              SET status='paid',paid_at=clock_timestamp()
              WHERE request_id=:request"""),
            {"request": newer_request},
        )
    assert {str(row["share_id"]) for row in await request_bulk.due()} == {newer_share}
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_request_payment_orders
              SET status='paid',paid_at=(SELECT paid_at+INTERVAL '1 second'
                FROM drive_request_payment_orders WHERE request_id=:newer)
              WHERE request_id=:older"""),
            {"older": older_request, "newer": newer_request},
        )
    assert {str(row["share_id"]) for row in await request_bulk.due()} == {newer_share}
    assert (
        await request_bulk.claim(
            user_id="owner", share_id=older_share, position=1, recipient_user_id="recipient"
        )
        is None
    )

    worker, adapter = _grant_worker(request_bulk)
    worker._pace = AsyncMock()
    assert (await worker.run(max_jobs=400, deadline_seconds=80))["outcomes"] == {"succeeded": 25}
    assert _effect_outcomes(request_bulk.db, newer_share) == {("succeeded", None): 25}
    assert _effect_outcomes(request_bulk.db, older_share) == {("queued", None): 25}
    assert {str(row["share_id"]) for row in await request_bulk.due()} == {older_share}
    assert (await worker.run(max_jobs=400, deadline_seconds=80))["outcomes"] == {"succeeded": 25}
    assert _effect_outcomes(request_bulk.db, older_share) == {("succeeded", None): 25}
    assert await request_bulk.due() == []
    assert adapter.create_reader.await_count == 50


@pytest.mark.asyncio
async def test_unresolved_post_blocks_other_paid_share_but_remains_reconcilable(
    request_bulk, sharing
):
    older_request, older_share = await _owner_approved_unpaid_batch(request_bulk, sharing)
    newer_request, newer_share = await _owner_approved_unpaid_batch(request_bulk, sharing)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_request_payment_orders
              SET status='paid',paid_at=clock_timestamp()
              WHERE request_id=:request"""),
            {"request": newer_request},
        )
        connection.execute(
            text("""UPDATE drive_request_payment_orders
              SET status='paid',paid_at=(SELECT paid_at+INTERVAL '1 second'
                FROM drive_request_payment_orders WHERE request_id=:newer)
              WHERE request_id=:older"""),
            {"older": older_request, "newer": newer_request},
        )
        connection.execute(
            text("""UPDATE drive_bulk_share_effects
              SET state='dispatching',lease_id=:lease,
                  lease_expires_at=clock_timestamp()+INTERVAL '120 seconds'
              WHERE share_id=:share AND position=1"""),
            {"share": older_share, "lease": str(uuid4())},
        )
    # The older order paid later, but a possible provider POST always wins
    # over payment ordering until it has been reconciled.
    assert await request_bulk.due() == []
    assert (
        await request_bulk.claim(
            user_id="owner", share_id=newer_share, position=1, recipient_user_id="recipient"
        )
        is None
    )
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_share_effects
              SET state='unknown',lease_id=NULL,lease_expires_at=NULL,
                  next_at=clock_timestamp()
              WHERE share_id=:share AND position=1"""),
            {"share": older_share},
        )
    assert {(str(row["share_id"]), row["state"]) for row in await request_bulk.due()} == {
        (older_share, "unknown")
    }
    assert (
        await request_bulk.claim(
            user_id="owner", share_id=newer_share, position=1, recipient_user_id="recipient"
        )
        is None
    )
    # Unknown work is still claimable for read-only reconciliation.
    assert (
        await request_bulk.claim(
            user_id="owner", share_id=older_share, position=1, recipient_user_id="recipient"
        )
        is not None
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("ending", ["declined", "stopped", "expired", "checkout_closed"])
async def test_unpaid_batch_is_released_once_when_its_request_can_never_pay(
    request_bulk, sharing, monkeypatch, ending
):
    """An approved batch whose request ended unpaid stops being work at once.

    Its queued grants are released together, once, with the public "stopped"
    reason; the request keeps its own state (no partial-share news for files
    nobody paid for) and an earning that was never paid is void.
    """
    request_id, share_id = await _owner_approved_unpaid_batch(request_bulk, sharing)
    with sharing.db.engine.begin() as connection:
        if ending == "stopped":
            connection.execute(
                text("""UPDATE drive_share_requests SET access_stop_requested_at=clock_timestamp()
                WHERE request_id=:request"""),
                {"request": request_id},
            )
        elif ending == "expired":
            connection.execute(
                text("""UPDATE drive_share_requests
                SET expires_at=created_at+INTERVAL '1 millisecond' WHERE request_id=:request"""),
                {"request": request_id},
            )
        elif ending == "checkout_closed":
            # What the signed checkout.session.expired webhook records.
            connection.execute(
                text("""UPDATE drive_request_payment_orders SET status='expired'
                WHERE request_id=:request"""),
                {"request": request_id},
            )
        revision = connection.execute(
            text("SELECT revision FROM drive_share_requests WHERE request_id=:request"),
            {"request": request_id},
        ).scalar_one()
    if ending == "declined":
        await sharing.decline_or_cancel(
            user_id="owner", request_id=request_id, revision=revision, decision="declined"
        )
    offers = _count_offers(request_bulk, monkeypatch)
    worker, adapter = _grant_worker(request_bulk)
    worker._pace = AsyncMock()

    assert (await worker.run(max_jobs=400, deadline_seconds=80))["outcomes"] == {"not_claimed": 25}
    for _ in range(3):
        assert (await worker.run(max_jobs=400, deadline_seconds=80))["outcomes"] == {}
    assert offers == [25, 0, 0, 0]
    assert _effect_outcomes(request_bulk.db, share_id) == {("skipped", "stopped"): 25}
    adapter.create_reader.assert_not_awaited()
    with sharing.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT status FROM drive_bulk_shares WHERE share_id=:share"),
                {"share": share_id},
            ).scalar_one()
            == "failed"
        )
        assert connection.execute(
            text("SELECT status FROM drive_share_requests WHERE request_id=:request"),
            {"request": request_id},
        ).scalar_one() == ("declined" if ending == "declined" else "pending")
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_share_events
                WHERE request_id=:request AND event_type='document_share_outcome'"""),
                {"request": request_id},
            ).scalar_one()
            == 0
        )

    await DriveRequestOwnerPayoutService(db=sharing.db).reconcile_due(max_orders=4)
    with sharing.db.engine.connect() as connection:
        # A closed Checkout window alone does not end a live request; its
        # earning settles once the request itself ends.
        assert connection.execute(
            text("SELECT status FROM drive_request_owner_payouts WHERE request_id=:request"),
            {"request": request_id},
        ).scalar_one() == ("awaiting_delivery" if ending == "checkout_closed" else "void")


@pytest.mark.asyncio
async def test_unpaid_full_review_batch_released_after_checkout_closed_sends_no_outcome(
    request_bulk, sharing, monkeypatch
):
    """A full-review request (one batch, no positions): A's approval moved it to
    approved and created the order. B's single Checkout window then closed, so
    its queued grants are released unpaid. Nothing was shared and nobody paid:
    the request stays approved with no partial-share news for either side,
    and its unpaid earning is void at the request's deadline."""
    request_id = (await _request(sharing))["requestId"]
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=_search(request_bulk, request_id=request_id, count=3),
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request_id,
    )
    await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    with sharing.db.engine.begin() as connection:
        assert connection.execute(
            text("""SELECT r.status,o.status FROM drive_share_requests r
            JOIN drive_request_payment_orders o ON o.request_id=r.request_id
            WHERE r.request_id=:request"""),
            {"request": request_id},
        ).one() == ("approved", "awaiting_payment")
        # What the signed checkout.session.expired webhook records.
        connection.execute(
            text("""UPDATE drive_request_payment_orders SET status='expired'
            WHERE request_id=:request"""),
            {"request": request_id},
        )
    worker, adapter = _grant_worker(request_bulk)
    worker._pace = AsyncMock()

    assert (await worker.run(max_jobs=400, deadline_seconds=80))["outcomes"] == {"not_claimed": 3}
    assert _effect_outcomes(request_bulk.db, review["shareId"]) == {("skipped", "stopped"): 3}
    adapter.create_reader.assert_not_awaited()
    with sharing.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT status FROM drive_share_requests WHERE request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            == "approved"
        )
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_share_events
                WHERE request_id=:request AND event_type='document_share_outcome'"""),
                {"request": request_id},
            ).scalar_one()
            == 0
        )
    payouts = DriveRequestOwnerPayoutService(db=sharing.db)
    await payouts.reconcile_due(max_orders=4)
    with sharing.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT status FROM drive_request_owner_payouts WHERE request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            == "awaiting_delivery"
        )
        connection.execute(
            text("""UPDATE drive_share_requests
            SET expires_at=created_at+INTERVAL '1 millisecond' WHERE request_id=:request"""),
            {"request": request_id},
        )
    await payouts.reconcile_due(max_orders=4)
    with sharing.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT status FROM drive_request_owner_payouts WHERE request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            == "void"
        )


@pytest.mark.asyncio
async def test_unpaid_full_review_batch_skipped_while_still_payable_keeps_its_outcome(
    request_bulk, sharing, monkeypatch
):
    """Control for the test above: only a request that can never be paid any
    more keeps quiet. Here B can still pay when a grant is claimed while the
    owner's sharing is switched off, so it is skipped: the request reaches its
    partial outcome, with its news, exactly as before. (The queue itself never
    offers an unpaid grant; the claim is direct.)"""
    request_id = (await _request(sharing))["requestId"]
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=_search(request_bulk, request_id=request_id, count=3),
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request_id,
    )
    await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    monkeypatch.setattr(DriveBulkShareStore, "_owner_grants_enabled", staticmethod(lambda _: False))
    for position in range(1, 4):
        assert (
            await request_bulk.claim(
                user_id="owner",
                share_id=review["shareId"],
                position=position,
                recipient_user_id="recipient",
            )
            is None
        )
    assert ("queued", None) not in _effect_outcomes(request_bulk.db, review["shareId"])
    with sharing.db.engine.connect() as connection:
        assert connection.execute(
            text("""SELECT r.status,o.status FROM drive_share_requests r
            JOIN drive_request_payment_orders o ON o.request_id=r.request_id
            WHERE r.request_id=:request"""),
            {"request": request_id},
        ).one() == ("partial", "awaiting_payment")
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_share_events
                WHERE request_id=:request AND event_type='document_share_outcome'"""),
                {"request": request_id},
            ).scalar_one()
            == 2
        )


@pytest.mark.asyncio
async def test_discovery_79_files_deliver_in_four_batches_without_duplicate_effects(
    request_bulk, sharing
):
    from hushh_mcp.services.drive_request_discovery import discovery_evidence
    from tests.services.test_drive_request_search_unit import _discovery_checkpoint

    request = await _request(sharing, purpose_text="Files containing Cedar Rook")
    identity = request["requestId"]
    search = _search(request_bulk, request_id=identity, count=79, selection=FILE_ACTIVITY_SELECTION)
    checkpoint = _discovery_checkpoint()
    checkpoint.update(request_origin_id=identity, request_revision=request["revision"])
    with request_bulk.db.engine.connect() as connection:
        row = sharing._row(
            connection,
            "SELECT * FROM drive_share_requests WHERE request_id=:request",
            {"request": identity},
        )
        purpose = sharing._open_request(row)["purpose"]
    checkpoint["requested_period"] = {
        "start": purpose["periodStart"],
        "end": purpose["periodEnd"],
        "timezone": "UTC",
    }
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
            (stripe_mode,request_id,user_id,requester_user_id,status,paid_at)
            VALUES ('test',:request,'owner','recipient','paid',clock_timestamp())"""),
            {"request": identity},
        )
        rows = (
            connection.execute(
                text(
                    "SELECT position,metadata_envelope FROM drive_owner_search_results WHERE job_id=:job"
                ),
                {"job": search},
            )
            .mappings()
            .all()
        )
        for row in rows:
            file = request_bulk._open(
                row["metadata_envelope"],
                user_id="owner",
                resource_id=f"{search}:{row['position']}",
                purpose="owner-search-result",
            )
            file["mimeType"] = "video/mp4" if row["position"] % 2 else "application/pdf"
            file["sourceVersion"] = "9"
            file["discoveryEvidence"] = discovery_evidence(
                checkpoint, user_id="owner", generation=1, metadata=file
            )
            connection.execute(
                text(
                    "UPDATE drive_owner_search_results SET metadata_envelope=CAST(:envelope AS jsonb) WHERE job_id=:job AND position=:position"
                ),
                {
                    "job": search,
                    "position": row["position"],
                    "envelope": request_bulk._seal(
                        file,
                        user_id="owner",
                        resource_id=f"{search}:{row['position']}",
                        purpose="owner-search-result",
                    ),
                },
            )
    shares = []
    for start in range(1, 80, 25):
        positions = list(range(start, min(start + 25, 80)))
        review = await request_bulk.create_review(
            user_id="owner",
            search_job_id=search,
            client_request_id=str(uuid4()),
            recipients=[_recipient("recipient", "b@example.invalid")],
            excluded=[],
            origin_request_id=identity,
            selected_positions=positions,
        )
        await request_bulk.approve(
            user_id="owner",
            share_id=review["shareId"],
            revision=review["revision"],
            review_digest=review["reviewDigest"],
        )
        shares.append(review["shareId"])
    worker, adapter = _grant_worker(request_bulk)
    worker._pace = AsyncMock()
    for share_id in shares:
        for due in await request_bulk.due(limit=400):
            if str(due["share_id"]) != share_id:
                continue
            job = await request_bulk.claim(
                user_id="owner",
                share_id=share_id,
                position=due["position"],
                recipient_user_id="recipient",
            )
            assert job is not None
            assert await worker._grant(job) == "succeeded"
    assert adapter.create_reader.await_count == 79
    assert all(call.kwargs["metadata_only"] for call in adapter.inspect_shareable.await_args_list)
    assert (await worker.run(max_jobs=400, deadline_seconds=80))["outcomes"] == {}
    assert adapter.create_reader.await_count == 79
    with request_bulk.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders WHERE request_id=:request"),
                {"request": identity},
            ).scalar_one()
            == 1
        )
        counts = connection.execute(
            text(
                "SELECT b.file_count,count(e.*) FROM drive_bulk_shares b JOIN drive_bulk_share_effects e ON e.share_id=b.share_id WHERE b.origin_request_id=:request AND e.state='succeeded' GROUP BY b.share_id,b.file_count"
            ),
            {"request": identity},
        ).all()
        assert sorted(size for size, count in counts) == [4, 25, 25, 25]
        assert sum(count for size, count in counts) == 79
