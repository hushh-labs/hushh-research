"""The isolated V1 payment drain has exact checkout and durable refund scope."""

# ruff: noqa: F811 -- imported PostgreSQL fixtures

import hashlib
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_request_payment_checkout_worker import (
    DriveRequestPaymentCheckoutWorker,
)
from hushh_mcp.services.drive_request_payment_refund_worker import (
    DriveRequestPaymentRefundWorker,
)
from hushh_mcp.services.drive_request_payment_refunds import _claim_refunds
from hushh_mcp.services.drive_request_payment_service import DriveRequestPaymentService
from hushh_mcp.services.drive_request_payment_store import DriveRequestPaymentStore
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from tests.services.test_drive_document_selection import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    lifecycle,
)
from tests.services.test_drive_request_bulk_postgres import (  # noqa: F401
    _recipient,
    _request,
    _search,
    request_bulk,
)
from tests.services.test_drive_sharing_store import request, sharing  # noqa: F401


async def _payment_batch(
    sharing,
    *,
    marked: bool,
    approved: bool = True,
    current_revision: bool = True,
) -> str:
    request_id = (await request(sharing))["requestId"]
    job_id, share_id = str(uuid4()), str(uuid4())
    with sharing.db.engine.begin() as connection:
        revision = connection.execute(
            text("""UPDATE drive_share_requests SET payment_required=TRUE
                WHERE request_id=:request RETURNING revision"""),
            {"request": request_id},
        ).scalar_one()
        connection.execute(
            text("""INSERT INTO drive_owner_search_jobs
              (job_id,user_id,client_request_id,request_digest,
               connection_generation,consent_version,status,checkpoint_envelope,
               v1_statement_search)
              VALUES (:job,'owner',:client,:digest,1,'drive-owner-search-v1',
                'completed',CAST(:envelope AS jsonb),:marked)"""),
            {
                "job": job_id,
                "client": str(uuid4()),
                "digest": "a" * 64,
                "envelope": "{}",
                "marked": marked,
            },
        )
        connection.execute(
            text("""INSERT INTO drive_bulk_shares
              (share_id,user_id,search_job_id,client_request_id,request_digest,
               connection_generation,search_revision,review_digest,status,
               file_count,recipient_count,excluded_envelope,approved_at,
               origin_request_id,origin_request_revision,progressive_batch,
               approval_source)
              VALUES (:share,'owner',:job,:client,:digest,1,1,:review,:status,
                1,1,CAST(:envelope AS jsonb),:approved_at,:request,:revision,
                TRUE,:source)"""),
            {
                "share": share_id,
                "job": job_id,
                "client": str(uuid4()),
                "digest": "b" * 64,
                "review": "c" * 64,
                "status": "queued" if approved else "review_ready",
                "envelope": "{}",
                "approved_at": None
                if not approved
                else connection.execute(text("SELECT clock_timestamp()")).scalar_one(),
                "request": request_id,
                "revision": revision if current_revision else revision + 1,
                "source": "owner" if approved else None,
            },
        )
        connection.execute(
            text("""INSERT INTO drive_bulk_share_recipients
              (share_id,user_id,recipient_user_id,identity_envelope)
              VALUES (:share,'owner','recipient',CAST(:envelope AS jsonb))"""),
            {"share": share_id, "envelope": "{}"},
        )
        connection.execute(
            text("""INSERT INTO drive_bulk_share_files
              (share_id,user_id,position,source_job_id,source_position,
               file_digest,metadata_envelope,origin_request_id)
              VALUES (:share,'owner',1,:job,1,:digest,CAST(:envelope AS jsonb),
                :request)"""),
            {
                "share": share_id,
                "job": job_id,
                "digest": "d" * 64,
                "envelope": "{}",
                "request": request_id,
            },
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (request_id,user_id,requester_user_id,stripe_mode)
              VALUES (:request,'owner','recipient','test')"""),
            {"request": request_id},
        )
    return request_id


@pytest.mark.asyncio
async def test_v1_checkout_due_requires_marked_exact_owner_approval(sharing):
    positive = await _payment_batch(sharing, marked=True)
    unmarked = await _payment_batch(sharing, marked=False)
    unapproved = await _payment_batch(sharing, marked=True, approved=False)
    old_revision = await _payment_batch(sharing, marked=True, current_revision=False)

    store = DriveRequestPaymentStore(db=sharing.db)
    v1_due = await store.due_checkout_orders(limit=20, v1_only=True)
    assert [row["request_id"] for row in v1_due] == [positive]
    normal_due = await store.due_checkout_orders(limit=20)
    assert {row["request_id"] for row in normal_due} == {
        positive,
        unmarked,
        unapproved,
    }
    with sharing.db.engine.begin() as connection:
        provenance = dict(
            connection.execute(
                text("""SELECT request_id::text,v1_statement_search
                  FROM drive_request_payment_obligations""")
            ).all()
        )
    assert provenance == {
        positive: True,
        unmarked: False,
        unapproved: False,
        old_revision: False,
    }


@pytest.mark.asyncio
async def test_v1_request_marker_selects_frozen_checkout_but_cannot_replace_sealed_allow(sharing):
    request_id = await _payment_batch(sharing, marked=True, approved=False)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests SET v1_live_request=TRUE,
                owner_allowed_at=clock_timestamp() WHERE request_id=:request"""),
            {"request": request_id},
        )
        connection.execute(
            text("""UPDATE drive_request_payment_orders SET updated_at=clock_timestamp()
                WHERE request_id=:request"""),
            {"request": request_id},
        )
        marked = connection.execute(
            text("""SELECT v1_statement_search FROM drive_request_payment_obligations
                WHERE request_id=:request"""),
            {"request": request_id},
        ).scalar_one()
    store = DriveRequestPaymentStore(db=sharing.db)
    assert marked is True  # Durable refund provenance, not charging authority.
    assert [row["request_id"] for row in await store.due_checkout_orders(v1_only=True)] == [
        request_id
    ]
    assert not await store.v1_checkout_eligible(
        requester_user_id="recipient", request_id=request_id
    )
    with sharing.db.engine.begin() as connection:
        share_id = connection.execute(
            text("""UPDATE drive_bulk_shares SET approval_source='trusted_auto',
                approved_at=clock_timestamp(),status='queued'
                WHERE origin_request_id=:request RETURNING share_id"""),
            {"request": request_id},
        ).scalar_one()
        assert (
            connection.execute(
                text("SELECT v1_statement_search FROM drive_bulk_shares WHERE share_id=:share"),
                {"share": share_id},
            ).scalar_one()
            is True
        )
        connection.execute(
            text("""UPDATE drive_share_requests SET access_stop_requested_at=clock_timestamp()
                WHERE request_id=:request"""),
            {"request": request_id},
        )
    assert await store.due_checkout_orders(v1_only=True) == []
    assert await DriveBulkShareStore(db=sharing.db).v1_approved(
        user_id="owner", share_id=str(share_id)
    )  # The reconciliation lane remains identifiable after revocation.


@pytest.mark.asyncio
async def test_v1_owner_approval_keeps_complete_checkout_search_until_share_expiry(
    request_bulk, sharing
):
    created = await _request(sharing, purpose_text="Schwab brokerage statements from 2026")
    request_id = created["requestId"]
    job_id = _search(
        request_bulk,
        request_id=request_id,
        count=1,
        selection={
            "request_selection_version": 2,
            "request_time_intent": "document_coverage",
            "request_owner_review_required": True,
        },
    )
    with sharing.db.engine.begin() as connection:
        original_expiry = connection.execute(
            text("""UPDATE drive_owner_search_jobs
              SET v1_statement_search=TRUE,
                  expires_at=clock_timestamp()+INTERVAL '1 hour'
              WHERE job_id=:job RETURNING expires_at"""),
            {"job": job_id},
        ).scalar_one()
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=job_id,
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
    with sharing.db.engine.begin() as connection:
        retained = connection.execute(
            text("""SELECT j.expires_at,b.expires_at,b.v1_statement_search
              FROM drive_owner_search_jobs j JOIN drive_bulk_shares b
                ON b.search_job_id=j.job_id WHERE b.share_id=:share"""),
            {"share": review["shareId"]},
        ).one()
        obligation_marked = connection.execute(
            text("""SELECT v1_statement_search FROM drive_request_payment_obligations
              WHERE request_id=:request"""),
            {"request": request_id},
        ).scalar_one()
    assert retained[0] >= retained[1] > original_expiry
    assert retained[2] is True and obligation_marked is True
    store = DriveRequestPaymentStore(db=sharing.db)
    assert [row["request_id"] for row in await store.due_checkout_orders(v1_only=True)] == [
        request_id
    ]
    sources = await request_bulk.legacy_manual_checkout_sources(
        user_id="owner", request_id=request_id
    )
    assert [item["id"] for item in sources] == ["standup-file-1"]


@pytest.mark.asyncio
async def test_v1_checkout_rejects_expired_approved_share(sharing):
    request_id = await _payment_batch(sharing, marked=True)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_shares
              SET expires_at=clock_timestamp()-INTERVAL '1 second'
              WHERE origin_request_id=:request"""),
            {"request": request_id},
        )
    store = DriveRequestPaymentStore(db=sharing.db)
    assert await store.due_checkout_orders(v1_only=True) == []
    assert (
        await store.v1_checkout_eligible(requester_user_id="recipient", request_id=request_id)
        is False
    )


@pytest.mark.asyncio
async def test_approved_v1_share_remains_due_after_search_job_expires(sharing):
    positive = await _payment_batch(sharing, marked=True)
    unmarked = await _payment_batch(sharing, marked=False)
    with sharing.db.engine.begin() as connection:
        shares = dict(
            connection.execute(
                text("""SELECT origin_request_id::text,share_id::text
                  FROM drive_bulk_shares WHERE origin_request_id IN (:positive,:unmarked)"""),
                {"positive": positive, "unmarked": unmarked},
            ).all()
        )
        for share_id in shares.values():
            # Migration 353 records proof on the approval update. The compact
            # fixture inserted the already-approved row directly above.
            connection.execute(
                text("""UPDATE drive_bulk_shares SET approved_at=approved_at
                  WHERE share_id=:share"""),
                {"share": share_id},
            )
            connection.execute(
                text("""INSERT INTO drive_bulk_share_effects
                  (share_id,user_id,position,recipient_user_id)
                  VALUES (:share,'owner',1,'recipient')"""),
                {"share": share_id},
            )
            connection.execute(
                text("""INSERT INTO drive_bulk_share_notifications
                  (share_id,user_id,recipient_user_id)
                  VALUES (:share,'owner','recipient')"""),
                {"share": share_id},
            )
        assert (
            connection.execute(
                text("""SELECT v1_statement_search FROM drive_bulk_shares
              WHERE share_id=:share"""),
                {"share": shares[positive]},
            ).scalar_one()
            is True
        )
        # The grant queue carries only paid grants; provenance is under test.
        connection.execute(
            text("""UPDATE drive_request_payment_orders
              SET status='paid',paid_at=clock_timestamp()
              WHERE request_id IN (:positive,:unmarked)"""),
            {"positive": positive, "unmarked": unmarked},
        )
        connection.execute(text("DELETE FROM drive_owner_search_jobs WHERE user_id='owner'"))

    store = DriveBulkShareStore(db=sharing.db)
    assert await store.v1_approved(user_id="owner", share_id=shares[positive]) is True
    assert await store.v1_approved(user_id="owner", share_id=shares[unmarked]) is False
    assert [str(row["share_id"]) for row in await store.due(limit=10, v1_only=True)] == [
        shares[positive]
    ]
    assert [
        str(row["share_id"]) for row in await store.due_notifications(limit=10, v1_only=True)
    ] == [shares[positive]]
    assert (
        await store.claim_notification(
            share_id=shares[positive], recipient_user_id="recipient", v1_only=True
        )
        is not None
    )
    assert (
        await store.claim_notification(
            share_id=shares[unmarked], recipient_user_id="recipient", v1_only=True
        )
        is None
    )


@pytest.mark.asyncio
async def test_v1_refund_claim_survives_request_and_search_erasure(sharing):
    positive = await _payment_batch(sharing, marked=True)
    unmarked = await _payment_batch(sharing, marked=False)
    with sharing.db.engine.begin() as connection:
        for request_id in (positive, unmarked):
            connection.execute(
                text("""UPDATE drive_request_payment_orders
                  SET status='paid',paid_at=clock_timestamp(),
                    stripe_payment_intent_id=:intent
                  WHERE request_id=:request"""),
                {"request": request_id, "intent": f"pi_{request_id}"},
            )
        connection.execute(
            text("DELETE FROM drive_share_events WHERE request_id=:request"),
            {"request": positive},
        )
        # Erasure removes request-bound frozen shares before their parent;
        # the financial obligation keeps its own immutable V1 provenance.
        connection.execute(
            text("DELETE FROM drive_bulk_shares WHERE origin_request_id=:request"),
            {"request": positive},
        )
        connection.execute(
            text("DELETE FROM drive_share_requests WHERE request_id=:request"),
            {"request": positive},
        )
        connection.execute(
            text("DELETE FROM drive_owner_search_jobs WHERE user_id='owner'"),
        )
    service = DriveRequestPaymentService(db=sharing.db)
    with sharing.db.engine.begin() as connection:
        claims = _claim_refunds(service, connection, limit=4, v1_only=True)
    assert [claim["request_id"] for claim in claims] == [positive]
    with sharing.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("""SELECT status FROM drive_request_payment_refunds
              WHERE request_id=:request"""),
                {"request": unmarked},
            ).scalar_one_or_none()
            is None
        )
        assert (
            connection.execute(
                text("""SELECT v1_statement_search FROM drive_request_payment_obligations
              WHERE request_id=:request"""),
                {"request": positive},
            ).scalar_one()
            is True
        )


@pytest.mark.asyncio
async def test_v1_worker_flags_reach_payment_services(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_synthetic")
    checkout = SimpleNamespace(
        due_checkout_orders=AsyncMock(return_value=[]),
        checkout=AsyncMock(),
        defer_unready_checkout_order=AsyncMock(),
    )
    await DriveRequestPaymentCheckoutWorker(checkout).run(
        max_jobs=1, deadline_seconds=20, v1_only=True
    )
    checkout.due_checkout_orders.assert_awaited_once_with(limit=5, v1_only=True)

    refund = SimpleNamespace(reconcile_refunds=AsyncMock(return_value={"claimed": 0}))
    await DriveRequestPaymentRefundWorker(refund).run(max_jobs=1, deadline_seconds=20, v1_only=True)
    refund.reconcile_refunds.assert_awaited_once_with(max_orders=1, v1_only=True)


@pytest.mark.asyncio
async def test_v1_checkout_rejects_unapproved_batch_before_provider_io():
    service = DriveRequestPaymentService(db=object())
    service.v1_checkout_eligible = AsyncMock(return_value=False)
    service.payment_state = AsyncMock()
    with pytest.raises(DriveSharingError, match="payment_not_ready"):
        await service.checkout(requester_user_id="recipient", request_id=str(uuid4()), v1_only=True)
    service.payment_state.assert_not_awaited()


@pytest.mark.asyncio
async def test_signed_v1_paid_webhook_wakes_v1_after_commit(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    request_id, attempt_id = str(uuid4()), str(uuid4())
    payer_ref = hashlib.sha256(f"{request_id}:recipient".encode()).hexdigest()
    event = {
        "id": "evt_v1_synthetic",
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "object": "checkout.session",
                "id": "cs_v1_synthetic",
                "client_reference_id": request_id,
                "mode": "payment",
                "payment_status": "paid",
                "amount_total": 1000,
                "currency": "usd",
                "livemode": False,
                "payment_intent": "pi_v1_synthetic",
                "metadata": {
                    "payment_kind": "drive_request",
                    "request_id": request_id,
                    "payer_ref": payer_ref,
                    "checkout_attempt_id": attempt_id,
                },
            }
        },
    }
    obligation = {
        "request_id": request_id,
        "stripe_mode": "test",
        "erased_at": datetime.now(UTC),
        "checkout_attempt_id": attempt_id,
        "stripe_checkout_session_id": None,
        "stripe_payment_intent_id": None,
        "payer_ref": payer_ref,
        "amount_cents": 1000,
        "currency": "usd",
        "status": "checkout_open",
        "v1_statement_search": True,
    }
    provider = SimpleNamespace(Webhook=SimpleNamespace(construct_event=lambda *_: event))
    service = DriveRequestPaymentService(db=object(), stripe_api=provider)
    service._row = Mock(side_effect=[None, None, None, obligation])
    connection = SimpleNamespace(execute=Mock())

    async def transact(operation):
        return operation(connection)

    service._transaction = transact
    wake = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.drive_request_payment_service.wake_drive_work", wake)
    await service.process_webhook(payload=b"synthetic", signature="synthetic")
    assert [call.args[0] for call in wake.await_args_list] == ["v1", "sharing"]
    assert any(
        "UPDATE drive_request_payment_obligations" in str(call.args[0])
        for call in connection.execute.call_args_list
    )
